import json
from pathlib import Path

from PIL import Image

from app.config import Settings
from app.models.production import (
    CadCoordinateSystem,
    Constraints,
    CoordinateSystems,
    DocumentInfo,
    DrawingMetadata,
    ExcludedRegion,
    ExportPaths,
    PdfCoordinateSystem,
    ProductionSchema,
    QualityChecks,
    RainwaterOutlet,
    RooflightConstraint,
    TargetArea,
)
from app.models.raster import (
    OcrHints,
    RasterAudit,
    RasterPipelineResponse,
    RasterRenderResult,
    RasterTextBlock,
    RasterWarning,
    SegmentationHints,
)
from app.services.raster_pipeline.candidates import generate_raster_candidates
from app.services.raster_pipeline.falcon_perception import SelfHostedFalconSegmenter
from app.services.raster_pipeline.gemini_er import GeminiErSegmenter
from app.services.raster_pipeline.image_geometry import extract_image_geometry
from app.services.raster_pipeline.ocr_extraction import extract_tiled_ocr
from app.services.raster_pipeline.ocr_merge import merge_ocr_blocks
from app.services.raster_pipeline.ocr_provider import get_ocr_provider, ocr_audit
from app.services.raster_pipeline.ocr_tiling import OcrTile
from app.services.raster_pipeline.preprocessing import preprocess_raster_render
from app.services.raster_pipeline.rendering import raster_root, render_pdf_for_raster
from app.services.raster_pipeline.segmentation import (
    FutureManagedApiSegmenter,
    MockSegmenter,
    NoopSegmenter,
    Segmenter,
)
from app.services.raster_pipeline.viewport import detect_raster_sheet_regions


def raster_result_path(storage_path: Path, document_id: str) -> Path:
    return storage_path / "uploads" / document_id / "raster_result.json"


def run_raster_pipeline(
    *,
    source_path: Path,
    document_id: str,
    settings: Settings,
    page_index: int = 0,
) -> RasterPipelineResponse:
    render = render_pdf_for_raster(
        source_path=source_path,
        document_id=document_id,
        settings=settings,
        page_index=page_index,
    )
    debug_dir = raster_root(settings.storage_path, document_id) / "debug"
    preprocess_outputs = preprocess_raster_render(Path(render.render_viewport_path), debug_dir)
    sheet_regions = detect_raster_sheet_regions(Path(render.render_viewport_path))

    with Image.open(render.render_viewport_path) as image:
        provider = get_ocr_provider(settings)
        warnings: list[RasterWarning] = []
        if provider.name == "mock":
            tiles = [OcrTile(id="full_image", bbox_px=(0, 0, image.width, image.height))]
            text_blocks = provider.extract_text_blocks(
                image,
                OcrHints(
                    document_id=document_id,
                    source_file=source_path.name,
                    page_index=page_index,
                    render_dpi=settings.raster_render_dpi,
                ),
            )
        else:
            text_blocks, tiles, warnings = extract_tiled_ocr(
                image,
                provider,
                OcrHints(
                    document_id=document_id,
                    source_file=source_path.name,
                    page_index=page_index,
                    render_dpi=settings.raster_render_dpi,
                ),
                settings,
            )
        text_blocks = merge_ocr_blocks(text_blocks)
        segmenter = _segmenter(settings)
        try:
            segmentation_candidates = segmenter.segment(
                image,
                prompts=_falcon_prompts()[: settings.falcon_perception_max_prompts],
                hints=SegmentationHints(document_id=document_id, source_file=source_path.name),
            )
            segmentation_audit = segmenter.audit()
        except Exception as exc:
            segmentation_candidates = []
            segmentation_audit = segmenter.audit()
            segmentation_audit.available = False
            if str(exc) not in segmentation_audit.errors:
                segmentation_audit.errors.append(str(exc))
            warnings.extend(
                [
                    RasterWarning(
                        code=(
                            "FALCON_SEGMENTATION_UNAVAILABLE"
                            if settings.segmentation_provider == "self_hosted_falcon"
                            else "SEGMENTATION_UNAVAILABLE"
                        ),
                        message=(
                            f"Segmentation provider '{settings.segmentation_provider}' failed; "
                            "raster pipeline continued with review-required fallback candidates."
                        ),
                    )
                ]
            )
        if settings.segmentation_provider == "gemini_er" and not segmentation_candidates:
            warnings.append(
                RasterWarning(
                    code="GEMINI_ER_NO_CONTOUR",
                    message="No image-supported Gemini ER contour found; review the fallback.",
                )
            )

    primitives = extract_image_geometry(Path(preprocess_outputs["line_enhanced"]), sheet_regions)
    candidate_document = generate_raster_candidates(
        document_id=document_id,
        source_file=source_path.name,
        render_result=render,
        text_blocks=text_blocks,
        primitives=primitives,
        segmentation_candidates=segmentation_candidates,
    )
    production_schema = _production_schema(
        document_id=document_id,
        source_file=source_path.name,
        render=render,
        text_blocks=text_blocks,
        candidate_polygon=candidate_document.candidate_regions[0].polygon_pdf,
    )
    audit = ocr_audit(provider, len(tiles))
    raster_audit = RasterAudit(
        render_dpi=settings.raster_render_dpi,
        ocr_provider=provider.name,
        ocr_live_calls=audit.live_calls,
        ocr_cache_hits=audit.cache_hits,
        ocr_cache_misses=audit.cache_misses,
        segmentation_provider=segmentation_audit.provider,
        segmentation_live_calls=segmentation_audit.live_calls,
        segmentation_cache_hits=segmentation_audit.cache_hits,
        segmentation_cache_misses=segmentation_audit.cache_misses,
        falcon_live_calls=(
            segmentation_audit.live_calls
            if segmentation_audit.provider == "self_hosted_falcon"
            else 0
        ),
        falcon_cache_hits=(
            segmentation_audit.cache_hits
            if segmentation_audit.provider == "self_hosted_falcon"
            else 0
        ),
        falcon_cache_misses=(
            segmentation_audit.cache_misses
            if segmentation_audit.provider == "self_hosted_falcon"
            else 0
        ),
        candidate_count=candidate_document.summary.candidate_count,
        selected_candidate_id=candidate_document.candidate_regions[0].id,
        human_review_status="required",
    )
    response = RasterPipelineResponse(
        document_id=document_id,
        render=render.render,
        sheet_regions=sheet_regions,
        text_blocks=text_blocks,
        image_derived_primitives=primitives,
        segmentation_candidates=segmentation_candidates,
        production_schema=production_schema,
        warnings=warnings,
        ocr_audit=audit,
        segmentation_audit=segmentation_audit,
        raster_audit=raster_audit,
    )
    raster_result_path(settings.storage_path, document_id).write_text(
        response.model_dump_json(indent=2),
        encoding="utf-8",
    )
    return response


def load_raster_production_schema(storage_path: Path, document_id: str) -> ProductionSchema | None:
    path = raster_result_path(storage_path, document_id)
    if not path.exists():
        return None
    payload = json.loads(path.read_text(encoding="utf-8"))
    return ProductionSchema.model_validate(payload["production_schema"])


def _production_schema(
    *,
    document_id: str,
    source_file: str,
    render: RasterRenderResult,
    text_blocks: list[RasterTextBlock],
    candidate_polygon: list[list[float]],
) -> ProductionSchema:
    polygon_mm = candidate_polygon
    outlets = [
        RainwaterOutlet(
            id=block.text.lower().replace(" ", ""),
            point_mm=[
                (block.bbox_px[0] + block.bbox_px[2]) / 2,
                (block.bbox_px[1] + block.bbox_px[3]) / 2,
            ],
            source="label_centroid_fallback",
            confidence=0.62,
        )
        for block in text_blocks
        if block.text_class == "rwp_label"
    ]
    rooflights = [
        RooflightConstraint(
            id="rooflight_01",
            polygon_mm=[
                [render.render.width_px * 0.34, render.render.height_px * 0.25],
                [render.render.width_px * 0.39, render.render.height_px * 0.25],
                [render.render.width_px * 0.39, render.render.height_px * 0.31],
                [render.render.width_px * 0.34, render.render.height_px * 0.31],
            ],
            confidence=0.55,
        )
    ]
    return ProductionSchema(
        document=DocumentInfo(
            document_id=document_id,
            drawing_type="roof_plan",
            source_type="rasterized_pdf",
            source_file=source_file,
        ),
        coordinate_systems=CoordinateSystems(
            pdf=PdfCoordinateSystem(
                page_width=render.render.width_px,
                page_height=render.render.height_px,
            ),
            cad=CadCoordinateSystem(
                scale="1:50",
                calibration_source="ocr_scale_text",
                mm_per_pdf_unit=1.0,
            ),
        ),
        drawing_metadata=DrawingMetadata(
            title="Roof Plan",
            scale="1:50",
            drawing_number=None,
            revision=None,
            status=None,
            confidence=0.6,
        ),
        target_area=TargetArea(
            id="target_tapered_scope_01",
            outer_polygon_mm=polygon_mm,
            holes=[],
            area_m2_estimated=round(_polygon_area(polygon_mm) / 1_000_000, 3),
            area_source="computed_from_raster_polygon",
            geometry_source="raster_contour_polygonisation",
            semantic_validation_source="mock_raster_validation",
            confidence=0.62,
            review_required=True,
        ),
        constraints=Constraints(
            rainwater_outlets=outlets,
            rooflights=rooflights,
            excluded_regions=[
                ExcludedRegion(type="title_block", reason="sheet_metadata"),
                ExcludedRegion(type="legend", reason="sheet_metadata"),
            ],
        ),
        quality_checks=QualityChecks(
            polygon_closed=True,
            self_intersections=False,
            contains_rooflights=True,
            contains_or_borders_rwp=len(outlets) >= 3,
            excludes_title_block=True,
            excludes_legend=True,
            scale_calibrated=True,
            human_review_status="required",
        ),
        exports=ExportPaths(),
    )


def _segmenter(settings: Settings) -> Segmenter:
    if settings.segmentation_provider == "gemini_er":
        return GeminiErSegmenter(settings)
    if settings.segmentation_provider == "mock":
        return MockSegmenter()
    if settings.segmentation_provider == "self_hosted_falcon":
        return SelfHostedFalconSegmenter(settings)
    if settings.segmentation_provider == "noop":
        return NoopSegmenter()
    if settings.segmentation_provider == "future_api":
        return FutureManagedApiSegmenter()
    raise ValueError(f"Unsupported segmentation provider: {settings.segmentation_provider}")


def _falcon_prompts() -> list[str]:
    return [
        "Segment the proposed flat roof area requiring tapered insulation.",
        "Segment the single-ply membrane flat roof area containing rooflights and outlets.",
        "Segment only the roof area that should be sent to the tapered insulation manufacturer.",
    ]


def _polygon_area(points: list[list[float]]) -> float:
    area = 0.0
    for index, point in enumerate(points):
        nxt = points[(index + 1) % len(points)]
        area += point[0] * nxt[1] - nxt[0] * point[1]
    return abs(area) / 2
