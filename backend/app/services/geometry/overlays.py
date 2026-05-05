from pathlib import Path

import fitz
from PIL import Image, ImageDraw

from app.models.candidates import CandidateDocument, CandidateRegion

RANK_COLOURS = ["#ef4444", "#3b82f6", "#22c55e", "#f59e0b", "#a855f7"]


def render_candidate_overlay(
    *,
    source_path: Path,
    candidate_document: CandidateDocument,
    output_path: Path,
    top_n: int = 5,
    max_dimension_px: int = 1400,
    selected_candidate_id: str | None = None,
) -> Path:
    with fitz.open(source_path) as document:
        page = document[0]
        longest_side = max(page.rect.width, page.rect.height)
        scale = max_dimension_px / longest_side if longest_side else 1
        pixmap = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
        image = Image.frombytes("RGB", (pixmap.width, pixmap.height), pixmap.samples)

    draw = ImageDraw.Draw(image, "RGBA")
    visible_candidates = candidate_document.candidate_regions[:top_n]
    for index, candidate in enumerate(visible_candidates):
        if candidate.id == selected_candidate_id:
            continue
        _draw_candidate(
            draw,
            candidate,
            scale,
            RANK_COLOURS[index % len(RANK_COLOURS)],
            muted=selected_candidate_id is not None,
        )
    selected = next(
        (
            candidate
            for candidate in candidate_document.candidate_regions
            if candidate.id == selected_candidate_id
        ),
        None,
    )
    if selected is not None:
        _draw_candidate(draw, selected, scale, "#0891b2", selected=True)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    image.save(output_path)
    return output_path


def _draw_candidate(
    draw: ImageDraw.ImageDraw,
    candidate: CandidateRegion,
    scale: float,
    colour: str,
    *,
    selected: bool = False,
    muted: bool = False,
) -> None:
    if len(candidate.polygon_pdf) < 3:
        return
    points = [(point[0] * scale, point[1] * scale) for point in candidate.polygon_pdf]
    rgb = tuple(int(colour.lstrip("#")[i : i + 2], 16) for i in (0, 2, 4))
    fill_alpha = 28 if muted else 60 if selected else 35
    line_alpha = 100 if muted else 255 if selected else 230
    width = 5 if selected else 2 if muted else 3
    draw.polygon(points, fill=(*rgb, fill_alpha))
    draw.line([*points, points[0]], fill=(*rgb, line_alpha), width=width)
    x, y = points[0]
    draw.text((x + 4, y + 4), str(candidate.rank), fill=(*rgb, 255))
