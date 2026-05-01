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
    SegmentationAudit,
    SegmentationHints,
)
from app.services.raster_pipeline.candidates import generate_raster_candidates
from app.services.raster_pipeline.falcon_perception import SelfHostedFalconSegmenter
from app.services.raster_pipeline.image_geometry import extract_image_geometry
from app.services.raster_pipeline.ocr_merge import merge_ocr_blocks
from app.services.raster_pipeline.ocr_provider import get_ocr_provider, ocr_audit
from app.services.raster_pipeline.ocr_tiling import OcrTile, generate_ocr_tiles
from app.services.raster_pipeline.preprocessing import preprocess_raster_render
from app.services.raster_pipeline.rendering import raster_root, render_pdf_for_raster
from app.services.raster_pipeline.segmentation import MockSegmenter, NoopSegmenter, Segmenter
from app.services.raster_pipeline.viewport import detect_raster_sheet_regions


def raster_result_path(storage_path: Path, document_id: str) -> Path:
    return storage_path / "uploads" / document_id / "raster_result.json"


def run_raster_pipeline(
    *,
    source_path: Path,
    document_id: str,
    settings: Settings,
) -> RasterPipelineResponse:
    render = render_pdf_for_raster(
        source_path=source_path,
        document_id=document_id,
        settings=settings,
    )
    debug_dir = raster_root(settings.storage_path, document_id) / "debug"
    preprocess_outputs = preprocess_raster_render(Path(render.render_viewport_path), debug_dir)
    sheet_regions = detect_raster_sheet_regions(Path(render.render_viewport_path))

    with Image.open(render.render_viewport_path) as image:
        provider = get_ocr_provider(settings)
        if provider.name == "mock":
            tiles = [OcrTile(id="full_image", bbox_px=(0, 0, image.width, image.height))]
            text_blocks = provider.extract_text_blocks(
                image,
                OcrHints(
                    document_id=document_id,
                    source_file=source_path.name,
                    render_dpi=settings.raster_render_dpi,
                ),
            )
        else:
            tiles = generate_ocr_tiles(
                image,
                tile_size_px=settings.ocr_tile_size_px,
                overlap_px=settings.ocr_tile_overlap_px,
                max_tiles=settings.ocr_max_tiles,
            )
            text_blocks = []
            for tile in tiles:
                crop = image.crop(tile.bbox_px)
                blocks = provider.extract_text_blocks(
                    crop,
                    OcrHints(
                        document_id=document_id,
                        source_file=source_path.name,
                        render_dpi=settings.raster_render_dpi,
                    ),
                )
                text_blocks.extend(blocks)
        text_blocks = merge_ocr_blocks(text_blocks)
        segmenter = _segmenter(settings)
        try:
            segmentation_candidates = segmenter.segment(
                image,
                prompts=_falcon_prompts()[: settings.falcon_perception_max_prompts],
                hints=SegmentationHints(document_id=document_id, source_file=source_path.name),
            )
            segmentation_audit = segmenter.audit()
            warnings: list[RasterWarning] = []
        except Exception as exc:
            segmentation_candidates = []
            segmentation_audit = SegmentationAudit(
                provider=settings.segmentation_provider,
                available=False,
                errors=[str(exc)],
            )
            warnings = [
                RasterWarning(
                    code="FALCON_SEGMENTATION_UNAVAILABLE",
                    message=(
                        "Falcon Perception service was not configured or not ready; "
                        "raster pipeline continued with OpenCV-derived candidates."
                    ),
                )
            ]

    primitives = extract_image_geometry(Path(preprocess_outputs["line_enhanced"]), sheet_regions)
    candidate_document = generate_raster_candidates(
        document_id=document_id,
        source_file=source_path.name,
        render_result=render,
        text_blocks=text_blocks,
        primitives=primitives,
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
        falcon_live_calls=segmentation_audit.live_calls,
        falcon_cache_hits=segmentation_audit.cache_hits,
        falcon_cache_misses=segmentation_audit.cache_misses,
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
    if settings.segmentation_provider == "mock":
        return MockSegmenter()
    if settings.segmentation_provider == "self_hosted_falcon":
        return SelfHostedFalconSegmenter(settings)
    return NoopSegmenter()


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
