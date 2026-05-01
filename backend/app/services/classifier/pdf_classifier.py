from pathlib import Path
from statistics import mean

import fitz

from app.models.classification import ClassificationResult, PdfPageMetrics

TEXT_THRESHOLD = 20
VECTOR_PATH_THRESHOLD = 50
LARGE_IMAGE_RATIO_THRESHOLD = 0.65
HYBRID_IMAGE_RATIO_THRESHOLD = 0.20


def classify_source(path: Path, original_filename: str | None = None) -> ClassificationResult:
    suffix = (original_filename or path.name).lower().rsplit(".", maxsplit=1)[-1]
    if suffix in {"dwg", "dxf"}:
        return _classification_for_cad()
    if suffix in {"png", "jpg", "jpeg", "tif", "tiff", "webp"}:
        return _classification_for_image()
    if suffix != "pdf":
        return _classification_for_unknown()
    return _classify_pdf(path)


def _classify_pdf(path: Path) -> ClassificationResult:
    with fitz.open(path) as document:
        page_count = document.page_count
        text_character_count = 0
        vector_path_count = 0
        embedded_image_count = 0
        embedded_image_area = 0.0
        page_area = 0.0
        fonts: set[str] = set()
        dpis: list[float] = []
        pages: list[PdfPageMetrics] = []

        for index, page in enumerate(document):
            rect = page.rect
            page_area += rect.width * rect.height

            page_text = page.get_text("text") or ""
            page_text_count = len(page_text)
            text_character_count += page_text_count

            drawings = page.get_drawings()
            page_vector_count = len(drawings)
            vector_path_count += page_vector_count

            page_images = page.get_images(full=True)
            embedded_image_count += len(page_images)
            image_infos = page.get_image_info(xrefs=True)
            for image_info in image_infos:
                bbox = fitz.Rect(image_info["bbox"])
                embedded_image_area += bbox.width * bbox.height
                xres = image_info.get("xres")
                yres = image_info.get("yres")
                if isinstance(xres, int | float) and isinstance(yres, int | float):
                    dpis.append((float(xres) + float(yres)) / 2)

            for block in page.get_text("dict").get("blocks", []):
                if block.get("type") != 0:
                    continue
                for line in block.get("lines", []):
                    for span in line.get("spans", []):
                        font = span.get("font")
                        if isinstance(font, str) and font:
                            fonts.add(font)

            pages.append(
                PdfPageMetrics(
                    page_number=index + 1,
                    width_points=round(rect.width, 3),
                    height_points=round(rect.height, 3),
                    vector_path_count=page_vector_count,
                    embedded_image_count=len(page_images),
                    text_character_count=page_text_count,
                )
            )

    image_area_ratio = embedded_image_area / page_area if page_area else 0.0
    has_extractable_text = text_character_count >= TEXT_THRESHOLD
    has_vector_paths = vector_path_count >= VECTOR_PATH_THRESHOLD
    large_page_image_detected = image_area_ratio >= LARGE_IMAGE_RATIO_THRESHOLD
    estimated_dpi = round(mean(dpis), 1) if dpis else None

    source_type, recommended_pipeline, confidence, signals = _choose_pdf_classification(
        has_extractable_text=has_extractable_text,
        has_vector_paths=has_vector_paths,
        image_area_ratio=image_area_ratio,
        large_page_image_detected=large_page_image_detected,
    )

    return ClassificationResult(
        has_extractable_text=has_extractable_text,
        text_character_count=text_character_count,
        has_vector_paths=has_vector_paths,
        vector_path_count=vector_path_count,
        embedded_image_count=embedded_image_count,
        embedded_image_area_ratio=round(image_area_ratio, 4),
        large_page_image_detected=large_page_image_detected,
        recommended_pipeline=recommended_pipeline,
        source_type=source_type,
        page_count=page_count,
        font_count=len(fonts),
        estimated_dpi=estimated_dpi,
        confidence=confidence,
        signals=signals,
        pages=pages,
    )


def _choose_pdf_classification(
    *,
    has_extractable_text: bool,
    has_vector_paths: bool,
    image_area_ratio: float,
    large_page_image_detected: bool,
) -> tuple[str, str, float, list[str]]:
    signals: list[str] = []
    if has_extractable_text:
        signals.append("extractable_text")
    if has_vector_paths:
        signals.append("native_vector_paths")
    if image_area_ratio > 0:
        signals.append("embedded_images")
    if large_page_image_detected:
        signals.append("large_page_image")

    if large_page_image_detected and not has_vector_paths:
        return "rasterized_pdf", "raster_first", 0.9, signals
    is_hybrid_candidate = image_area_ratio >= HYBRID_IMAGE_RATIO_THRESHOLD and (
        has_vector_paths or has_extractable_text
    )
    if is_hybrid_candidate:
        return "hybrid_pdf", "hybrid", 0.82, signals
    if has_vector_paths:
        confidence = 0.95 if has_extractable_text else 0.86
        return "vector_pdf", "vector_first", confidence, signals
    if has_extractable_text:
        return "unknown_low_quality_source", "raster_first", 0.55, signals
    return "unknown_low_quality_source", "raster_first", 0.45, signals


def _classification_for_cad() -> ClassificationResult:
    return ClassificationResult(
        has_extractable_text=False,
        text_character_count=0,
        has_vector_paths=True,
        vector_path_count=0,
        embedded_image_count=0,
        embedded_image_area_ratio=0,
        large_page_image_detected=False,
        recommended_pipeline="cad_first",
        source_type="dwg_dxf",
        page_count=0,
        font_count=0,
        estimated_dpi=None,
        confidence=0.95,
        signals=["cad_extension"],
        pages=[],
    )


def _classification_for_image() -> ClassificationResult:
    return ClassificationResult(
        has_extractable_text=False,
        text_character_count=0,
        has_vector_paths=False,
        vector_path_count=0,
        embedded_image_count=1,
        embedded_image_area_ratio=1,
        large_page_image_detected=True,
        recommended_pipeline="raster_first",
        source_type="image_file",
        page_count=0,
        font_count=0,
        estimated_dpi=None,
        confidence=0.9,
        signals=["image_extension"],
        pages=[],
    )


def _classification_for_unknown() -> ClassificationResult:
    return ClassificationResult(
        has_extractable_text=False,
        text_character_count=0,
        has_vector_paths=False,
        vector_path_count=0,
        embedded_image_count=0,
        embedded_image_area_ratio=0,
        large_page_image_detected=False,
        recommended_pipeline="raster_first",
        source_type="unknown_low_quality_source",
        page_count=0,
        font_count=0,
        estimated_dpi=None,
        confidence=0.2,
        signals=["unsupported_extension"],
        pages=[],
    )
