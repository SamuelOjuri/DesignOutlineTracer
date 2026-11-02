"""Offline-first outline benchmark: capture model outlines once, score geometry variants many times.

Live capture is opt-in (--allow-live with an explicit call cap) and uses the production
prompt, crop and parser from backend.app. Scoring never calls a provider.
"""
import asyncio
from datetime import date, datetime, timezone
from hashlib import sha256
from io import BytesIO
import json
import math
import os
from pathlib import Path
import shutil
import statistics
import subprocess
import time
from typing import Callable, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .contracts import ReferenceError, validate_box
from .outline_metrics import score_outline


REPOSITORY = Path(__file__).resolve().parents[2]
MANIFEST = REPOSITORY / "docs/roi-evaluation/outline-manifest.json"
PRIVATE = REPOSITORY / "docs/roi-evaluation/private/outline"


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class OutlineReview(StrictModel):
    reviewer: str = Field(min_length=1, max_length=120)
    reviewed_on: date


class OutlineReference(StrictModel):
    polygons: list[list[tuple[float, float]]] = Field(min_length=1)
    method: str = Field(min_length=1, max_length=2000)
    notes: str | None = Field(default=None, max_length=2000)
    edges: list[dict] | None = None

    @model_validator(mode="after")
    def rings(self):
        if any(len(ring) < 3 for ring in self.polygons):
            raise ValueError("Reference rings need at least three vertices")
        return self


class OutlineCase(StrictModel):
    id: str = Field(min_length=1, max_length=80, pattern=r"^[A-Za-z0-9_-]+$")
    document: str = Field(min_length=1, max_length=300)
    source_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    page_index: int = Field(ge=0)
    split: Literal["development", "held_out"]
    tags: list[str]
    roi_box: list[float]
    boundary_policy: Literal["inner_parapet", "roof_deck", "outer_roof"]
    status: Literal["awaiting_review", "reviewed"]
    review: OutlineReview | None = None
    reference: OutlineReference

    @model_validator(mode="after")
    def check(self):
        validate_box(self.roi_box)
        if (self.status == "reviewed") != (self.review is not None):
            raise ValueError("Reviewed outline cases need a reviewer, and only reviewed cases may have one")
        return self


class OutlineManifest(StrictModel):
    schema_version: Literal["outline-evaluation-v1"]
    policy_status: Literal["draft", "approved"]
    render: dict
    cases: list[OutlineCase] = Field(min_length=1)

    @model_validator(mode="after")
    def unique(self):
        if len({case.id for case in self.cases}) != len(self.cases):
            raise ValueError("Duplicate outline case ID")
        return self


def load_outline_manifest(path: Path = MANIFEST) -> OutlineManifest:
    return OutlineManifest.model_validate_json(path.read_text(encoding="utf-8"))


def page_png(case: OutlineCase, cache: Path = PRIVATE) -> bytes:
    """Render the case page at the app's PDF.js scale (2) with pdfium; cached per source hash."""
    path = cache / f"{case.source_sha256[:16]}-p{case.page_index}.png"
    if path.exists():
        return path.read_bytes()
    document = REPOSITORY / case.document
    if sha256(document.read_bytes()).hexdigest() != case.source_sha256:
        raise ReferenceError("outline_source_hash_mismatch")
    import pypdfium2

    image = pypdfium2.PdfDocument(str(document))[case.page_index].render(scale=2).to_pil().convert("RGB")
    stream = BytesIO()
    image.save(stream, format="PNG")
    cache.mkdir(parents=True, exist_ok=True)
    path.write_bytes(stream.getvalue())
    return stream.getvalue()


def page_vectors(case: OutlineCase, cache: Path = PRIVATE) -> list[dict]:
    """Vector segments from the app's own PDF.js extractor (scripts/extract-pdf-vectors.ts)."""
    path = cache / f"{case.source_sha256[:16]}-p{case.page_index}-vectors.json"
    if not path.exists():
        node, entry = shutil.which("node"), REPOSITORY / "node_modules/vite-node/vite-node.mjs"
        if node is None or not entry.exists():
            raise ReferenceError("vite_node_unavailable")
        cache.mkdir(parents=True, exist_ok=True)
        subprocess.run([node, str(entry), "scripts/extract-pdf-vectors.ts", str(REPOSITORY / case.document),
                        str(case.page_index + 1), str(path)], cwd=REPOSITORY, check=True, timeout=600,
                       capture_output=True)
    return json.loads(path.read_text(encoding="utf-8"))["segments"]


def roi_vectors(segments: list[dict], width: int, height: int, box: list[float]) -> list[dict]:
    """Mirror of the frontend's vectorsForRegion (src/hooks/useOutlineDetection.ts)."""
    left, top, right, bottom = box[1] * width / 1000, box[0] * height / 1000, box[3] * width / 1000, box[2] * height / 1000
    margin = max(right - left, bottom - top) * .08
    kept = [segment for segment in segments
            if max(segment["start"]["x"], segment["end"]["x"]) >= left - margin
            and min(segment["start"]["x"], segment["end"]["x"]) <= right + margin
            and max(segment["start"]["y"], segment["end"]["y"]) >= top - margin
            and min(segment["start"]["y"], segment["end"]["y"]) <= bottom + margin]
    kept.sort(key=lambda segment: -((segment["end"]["x"] - segment["start"]["x"]) ** 2
                                    + (segment["end"]["y"] - segment["start"]["y"]) ** 2))
    return kept[:2000]


def read_env_file(path: Path) -> None:
    """Load KEY=VALUE lines into the environment without overriding existing values."""
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip('"'))


def capture(case_ids: list[str] | None, runs: int, *, allow_live: bool, max_calls: int,
            manifest_path: Path = MANIFEST, cache: Path = PRIVATE, env_file: Path | None = None) -> dict:
    """One provider attempt per run (no retry), so corrupted-output rates are measured directly."""
    if not allow_live or max_calls < 1:
        raise ReferenceError("live_capture_not_authorized")
    if env_file:
        read_env_file(env_file)
    from backend.app.config import Settings
    from backend.app.errors import RoiError
    from backend.app.gemini import OUTLINE_SYSTEM_PROMPT, GeminiProvider
    from backend.app.images import prepare_image
    from backend.app.outline_geometry import prepare_outline_crop
    from backend.app.outline_service import PROMPT_VERSION, model_schema, outline_prompt, parse_model_outline

    manifest = load_outline_manifest(manifest_path)
    cases = [case for case in manifest.cases if not case_ids or case.id in case_ids]
    settings = Settings.from_env()
    if not (settings.allow_live and settings.api_key):
        raise ReferenceError("provider_not_configured")
    summary = {"status": "complete", "calls": 0, "outcomes": {}}

    async def run_all():
        provider = GeminiProvider(settings)
        try:
            for case in cases:
                png = page_png(case, cache)
                overview = prepare_image(png, settings)
                prepared = prepare_outline_crop(png, case.roi_box)
                prompt = outline_prompt(case.roi_box, prepared.crop, overview.width, overview.height,
                                        case.boundary_policy, "")
                for _ in range(runs):
                    if summary["calls"] >= max_calls:
                        summary["status"] = "partial"
                        return
                    summary["calls"] += 1
                    record = {"case_id": case.id, "captured_at": datetime.now(timezone.utc).isoformat(),
                              "model": settings.model, "thinking_level": settings.thinking_level,
                              "structured_output": settings.structured_output,
                              "json_mode": getattr(settings, "json_mode", False), "prompt_version": PROMPT_VERSION,
                              "prompt_sha256": sha256((OUTLINE_SYSTEM_PROMPT + prompt).encode()).hexdigest(),
                              "crop": prepared.crop, "polygons": None, "error": None}
                    started = time.perf_counter()
                    text = ""
                    try:
                        raw = await provider.generate_with_context(prepared.png, prompt, model_schema(), overview.png)
                        text = raw.text
                        record.update(finish_reason=raw.finish_reason, response_chars=len(text))
                        result = parse_model_outline(text, settings.max_response_bytes)
                        record.update(outcome="parsed", roi_too_tight=result.roi_too_tight,
                                      polygons=[[point.model_dump() for point in polygon.points]
                                                for polygon in result.polygons])
                    except RoiError as error:
                        diagnostic = getattr(error, "diagnostic", None)
                        record.update(outcome="rejected" if text else "provider_error",
                                      error={"code": error.code, "category": diagnostic.value if diagnostic else None,
                                             "detail": getattr(error, "detail", None)})
                    record["duration_ms"] = round((time.perf_counter() - started) * 1000)
                    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%f")
                    target = cache / "captures" / case.id
                    target.mkdir(parents=True, exist_ok=True)
                    (target / f"{stamp}.json").write_text(json.dumps(record, indent=1), encoding="utf-8")
                    (target / f"{stamp}.txt").write_text(text, encoding="utf-8")
                    key = record["outcome"] if record["outcome"] == "parsed" else f"{record['outcome']}:{record['error']['code']}"
                    summary["outcomes"][key] = summary["outcomes"].get(key, 0) + 1
        finally:
            await provider.close()

    asyncio.run(run_all())
    return summary


def load_captures(case_id: str, cache: Path = PRIVATE, *, since: str | None = None) -> list[dict]:
    """Captured runs, re-parsed with the CURRENT production parser from their stored raw text."""
    from backend.app.errors import RoiError
    from backend.app.outline_service import parse_model_outline

    directory = cache / "captures" / case_id
    records = []
    for path in sorted(directory.glob("*.json")) if directory.exists() else []:
        record = json.loads(path.read_text(encoding="utf-8"))
        if since is not None and record["captured_at"] < since:
            continue
        text_path = path.with_suffix(".txt")
        if record.get("outcome") != "provider_error" and text_path.exists():
            try:
                result = parse_model_outline(text_path.read_text(encoding="utf-8"), 256 * 1024)
                record.update(outcome="parsed", roi_too_tight=result.roi_too_tight, error=None,
                              polygons=[[point.model_dump() for point in polygon.points] for polygon in result.polygons])
            except RoiError as error:
                diagnostic = getattr(error, "diagnostic", None)
                record.update(outcome="rejected", polygons=None,
                              error={"code": error.code, "category": diagnostic.value if diagnostic else None})
        records.append(record)
    return records


def _model_rings(record: dict) -> list[list[tuple[float, float]]]:
    crop = record["crop"]
    return [[(crop["x"] + point["x"] * crop["width"] / 1000, crop["y"] + point["y"] * crop["height"] / 1000)
             for point in polygon] for polygon in record["polygons"] or []]


def _production(**options) -> Callable:
    def run(context: dict, record: dict):
        from backend.app.outline_geometry import refine_outline_polygons

        result = refine_outline_polygons(context["png"], context["case"].roi_box, record["crop"], record["polygons"],
                                         context["vectors"], boundary_policy=context["case"].boundary_policy, **options)
        if not result["proposals"]:
            return None, result["status"]
        return [[(point["x"], point["y"]) for point in proposal["points"]] for proposal in result["proposals"]], None
    return run


def _side_aware(context: dict, record: dict):
    from .outline_side_aware import side_aware_refine

    result = side_aware_refine(context["png"], context["case"].roi_box, record["crop"], record["polygons"], context["vectors"])
    if not result["proposals"]:
        return None, result["status"]
    return [[(point["x"], point["y"]) for point in proposal["points"]] for proposal in result["proposals"]], None


VARIANTS: dict[str, Callable] = {
    "model": lambda context, record: (_model_rings(record), None),
    "production": _production(),
    "production+shapely": _production(cleanup="shapely"),
    "opencv-side": _side_aware,
}


def score(variants: list[str] | None = None, *, manifest_path: Path = MANIFEST, cache: Path = PRIVATE,
          tolerances: tuple[float, ...] = (2., 5.), since: str | None = None) -> dict:
    """Score each variant on the same captured model outlines; failures count as zero overlap."""
    manifest = load_outline_manifest(manifest_path)
    chosen = variants or list(VARIANTS)
    unknown = set(chosen) - set(VARIANTS)
    if unknown:
        raise ReferenceError("unknown_outline_variant")
    report = {"provisional": any(case.status != "reviewed" for case in manifest.cases),
              "tolerances_px": list(tolerances), "cases": {}, "overall": {}}
    totals: dict[str, list[dict]] = {name: [] for name in chosen}
    for case in manifest.cases:
        records = load_captures(case.id, cache, since=since)
        usable = [record for record in records if record.get("outcome") == "parsed" and not record.get("roi_too_tight")]
        context = None
        if usable:
            png = page_png(case, cache)
            from PIL import Image

            with Image.open(BytesIO(png)) as image:
                width, height = image.size
            context = {"case": case, "png": png, "vectors": roi_vectors(page_vectors(case, cache), width, height, case.roi_box)}
        reference = [[tuple(point) for point in ring] for ring in case.reference.polygons]
        by_mode = {}
        for record in records:
            mode = "json" if record.get("json_mode") else "free"
            parsed, total = by_mode.get(mode, (0, 0))
            by_mode[mode] = (parsed + (record.get("outcome") == "parsed"), total + 1)
        case_report = {"captures": len(records), "usable": len(usable),
                       "parsed_by_mode": {mode: f"{parsed}/{total}" for mode, (parsed, total) in sorted(by_mode.items())},
                       "variants": {}}
        for name in chosen:
            rows = []
            for record in records:
                started = time.perf_counter()
                if record.get("outcome") != "parsed":
                    rings, failure = None, f"{record.get('outcome')}:{(record.get('error') or {}).get('category')}"
                elif record.get("roi_too_tight"):
                    rings, failure = None, "model_roi_too_tight"
                else:
                    try:
                        rings, failure = VARIANTS[name](context, record)
                    except Exception as error:  # Variant errors are results, not harness crashes.
                        rings, failure = None, getattr(error, "code", type(error).__name__)
                elapsed = (time.perf_counter() - started) * 1000
                row = {"failure": failure, "ms": elapsed}
                if rings:
                    row.update(score_outline(rings, reference, tolerances).as_dict())
                else:
                    row.update(iou=0., boundary_f1={f"{t:g}px": 0. for t in tolerances})
                rows.append(row)
            case_report["variants"][name] = _aggregate(rows, tolerances)
            totals[name].extend(rows)
        report["cases"][case.id] = case_report
    report["overall"] = {name: _aggregate(rows, tolerances) for name, rows in totals.items()}
    return report


def _aggregate(rows: list[dict], tolerances) -> dict:
    if not rows:
        return {"n": 0}
    scored = [row for row in rows if row["failure"] is None]
    keys = [f"{t:g}px" for t in tolerances]
    mean = lambda values: round(statistics.fmean(values), 4) if values else None
    finite = [row["hausdorff"] for row in scored if math.isfinite(row["hausdorff"])]
    return {
        "n": len(rows), "failures": len(rows) - len(scored),
        "iou": mean([row["iou"] for row in rows]),
        "iou_success": mean([row["iou"] for row in scored]),
        **{f"boundary_f1_{key}": mean([row["boundary_f1"][key] for row in rows]) for key in keys},
        "hausdorff_median": round(statistics.median(finite), 2) if finite else None,
        "mean_distance": mean([row["mean_distance"] for row in scored if math.isfinite(row["mean_distance"])]),
        "vertices_mean": mean([row["vertices"] for row in scored]),
        "ms_mean": mean([row["ms"] for row in rows]),
    }


def review_sheets(case_ids: list[str] | None = None, *, manifest_path: Path = MANIFEST, cache: Path = PRIVATE,
                  output: Path | None = None) -> dict:
    """Render one review sheet per reference (overview + zoomed corners) for domain review; offline."""
    from PIL import Image

    from .outline_references import render_review

    manifest = load_outline_manifest(manifest_path)
    selected = [case for case in manifest.cases if not case_ids or case.id in case_ids]
    if case_ids and len(selected) != len(set(case_ids)):
        raise ReferenceError("unknown_outline_case")
    directory = output or cache / "review"
    directory.mkdir(parents=True, exist_ok=True)
    sheets = {}
    for case in selected:
        page = Image.open(BytesIO(page_png(case, cache)))
        path = directory / f"{case.id}.png"
        render_review(page, case.reference.polygons, path)
        sheets[case.id] = {"sheet": str(path), "status": case.status}
    return {"status": "ok", "sheets": sheets}


def markdown(report: dict) -> str:
    keys = [f"{t:g}px" for t in report["tolerances_px"]]
    header = ("| Case | Variant | n | Failures | IoU (failures = 0) | IoU (successes) | "
              + " | ".join(f"Boundary F1 @{key}" for key in keys) + " | Median Hausdorff px | Mean distance px | ms |")
    lines = [header, "|" + "---|" * (9 + len(keys))]
    sections = list(report["cases"].items()) + [("**overall**", {"variants": report["overall"]})]
    for case_id, case in sections:
        for name, value in case["variants"].items():
            if not value.get("n"):
                continue
            cells = [case_id, name, value["n"], value["failures"], value["iou"], value["iou_success"],
                     *[value[f"boundary_f1_{key}"] for key in keys], value["hausdorff_median"],
                     value["mean_distance"], value["ms_mean"]]
            lines.append("| " + " | ".join("—" if cell is None else str(cell) for cell in cells) + " |")
    lines.append("\nParsed / captured, by JSON mode: " + "; ".join(
        f"{case_id} {case['parsed_by_mode']}" for case_id, case in report["cases"].items()))
    if report["provisional"]:
        lines.append("\nProvisional: one or more references await domain review.")
    return "\n".join(lines)
