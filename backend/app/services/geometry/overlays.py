from pathlib import Path

import fitz
from PIL import Image, ImageDraw

from app.models.candidates import CandidateDocument, CandidateRegion
from app.services.geometry.review_visibility import is_review_visible_candidate

RANK_COLOURS = ["#ef4444", "#3b82f6", "#22c55e", "#f59e0b", "#a855f7"]


def render_candidate_overlay(
    *,
    source_path: Path,
    candidate_document: CandidateDocument,
    output_path: Path,
    top_n: int = 5,
    max_dimension_px: int = 1400,
) -> Path:
    with fitz.open(source_path) as document:
        page = document[0]
        longest_side = max(page.rect.width, page.rect.height)
        scale = max_dimension_px / longest_side if longest_side else 1
        pixmap = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
        image = Image.frombytes("RGB", (pixmap.width, pixmap.height), pixmap.samples)

    draw = ImageDraw.Draw(image, "RGBA")
    for index, candidate in enumerate(_overlay_candidates(candidate_document, top_n)):
        _draw_candidate(draw, candidate, scale, RANK_COLOURS[index % len(RANK_COLOURS)])

    output_path.parent.mkdir(parents=True, exist_ok=True)
    image.save(output_path)
    return output_path


def _overlay_candidates(
    candidate_document: CandidateDocument,
    top_n: int,
) -> list[CandidateRegion]:
    selected = list(candidate_document.candidate_regions[:top_n])
    selected_ids = {candidate.id for candidate in selected}
    review_candidates = [
        candidate
        for candidate in candidate_document.candidate_regions
        if candidate.id not in selected_ids and is_review_visible_candidate(candidate)
    ]
    return [*selected, *review_candidates]


def _draw_candidate(
    draw: ImageDraw.ImageDraw,
    candidate: CandidateRegion,
    scale: float,
    colour: str,
) -> None:
    if len(candidate.polygon_pdf) < 3:
        return
    points = [(point[0] * scale, point[1] * scale) for point in candidate.polygon_pdf]
    rgb = tuple(int(colour.lstrip("#")[i : i + 2], 16) for i in (0, 2, 4))
    draw.polygon(points, fill=(*rgb, 35))
    draw.line([*points, points[0]], fill=(*rgb, 230), width=3)
    x, y = points[0]
    draw.text((x + 4, y + 4), str(candidate.rank), fill=(*rgb, 255))
