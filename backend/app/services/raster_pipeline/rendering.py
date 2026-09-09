from pathlib import Path

import fitz

from app.config import Settings
from app.models.raster import RasterRenderMetadata, RasterRenderResult
from app.services.raster_pipeline.errors import RasterRenderTooLarge


def raster_root(storage_path: Path, document_id: str) -> Path:
    return storage_path / "uploads" / document_id / "raster"


def render_pdf_for_raster(
    *,
    source_path: Path,
    document_id: str,
    settings: Settings,
    page_index: int = 0,
) -> RasterRenderResult:
    output_dir = raster_root(settings.storage_path, document_id)
    output_dir.mkdir(parents=True, exist_ok=True)

    with fitz.open(source_path) as document:
        if page_index < 0 or page_index >= document.page_count:
            raise ValueError(
                f"page_index {page_index} is out of range for a {document.page_count}-page PDF"
            )
        page = document[page_index]
        preview = _render_page(page, settings.raster_preview_dpi, settings.raster_max_render_pixels)
        full = _render_page(page, settings.raster_render_dpi, settings.raster_max_render_pixels)

    preview_path = output_dir / "preview.png"
    full_path = output_dir / "render_full.png"
    viewport_path = output_dir / "render_viewport.png"
    preview.save(preview_path)
    full.save(full_path)
    # Phase 7 first pass uses the full render; viewport detection can refine this later.
    full.save(viewport_path)

    return RasterRenderResult(
        render=RasterRenderMetadata(
            page_index=page_index,
            preview_dpi=settings.raster_preview_dpi,
            render_dpi=settings.raster_render_dpi,
            width_px=full.width,
            height_px=full.height,
            render_scope="drawing_viewport",
            max_pixels_guard_applied=False,
        ),
        preview_path=str(preview_path),
        render_full_path=str(full_path),
        render_viewport_path=str(viewport_path),
        viewport_bbox_px=[0, 0, full.width, full.height],
    )


def _render_page(page: fitz.Page, dpi: int, max_pixels: int) -> fitz.Pixmap:
    scale = dpi / 72
    width = int(page.rect.width * scale)
    height = int(page.rect.height * scale)
    if width * height > max_pixels:
        raise RasterRenderTooLarge(
            f"Raster render would create {width * height} pixels, above limit {max_pixels}"
        )
    return page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
