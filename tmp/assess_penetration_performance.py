"""Local read-only performance assessment. Never initializes a live provider."""
import asyncio
import json
from pathlib import Path
from statistics import median
import sys
from time import perf_counter

import fitz

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.app.config import Settings
from backend.app.gemini import ProviderResult
from backend.app.images import prepare_image
from backend.app.models import DetectionInput, DetectionVector, PageContext
from backend.app.outline_geometry import OutlineCropSource, prepare_outline_crop
from backend.app.penetration_geometry import VectorIndex, plan_crops, refine_ring
from backend.app.penetration_service import scan_penetrations
from backend.app.service import PageRecord, RoiService, Session

SOURCE = Path(r"C:\Users\SamuelOjuri\OneDrive - Tapered Plus\Documents\Samsdocs\Roof Plan Docs\Example 3 - TP17256\TP17256_25.01 - A - input.pdf")
OUT = ROOT / "tmp/pdfs/penetration-performance"


def timed(function, repeats=3):
    values = []
    for _ in range(repeats):
        started = perf_counter()
        function()
        values.append(perf_counter() - started)
    return {"median_seconds": round(median(values), 4), "samples_seconds": [round(v, 4) for v in values]}


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    with fitz.open(SOURCE) as document:
        page = document[0]
        page.get_pixmap(matrix=fitz.Matrix(.5, .5), alpha=False).save(OUT / "overview.png")
        raster = page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False)
        original = raster.tobytes("png")
        width, height = raster.width, raster.height
    # Full-page scope gives an upper-bound example, not the user's selected outline.
    request = DetectionInput(page_id="assessment", request_id="assessment", task="penetration",
        source_image_hash="a" * 64, roi_revision=1, geometry_revision=1,
        accepted_rois=[{"id": "roof", "revision": 1, "box_2d": [0, 0, 1000, 1000]}],
        scopes=[{"roi_id": "roof", "outline_id": "assessment", "outer": [
            {"x": 0, "y": 0}, {"x": width, "y": 0},
            {"x": width, "y": height}, {"x": 0, "y": height}]}])
    crops, limited = plan_crops(request, width, height)
    def prepare_all():
        for _, box in crops:
            prepared = prepare_outline_crop(original, box)
            prepared.source.gray.close()
    def prepare_reused():
        source = OutlineCropSource(original)
        try:
            for _, box in crops:
                prepared = source.prepare(box)
                prepared.source.gray.close()
        finally:
            source.close()
    crop_parity = []
    source = OutlineCropSource(original)
    try:
        for _, box in crops:
            previous, reused = prepare_outline_crop(original, box), source.prepare(box)
            crop_parity.append(previous.crop == reused.crop and previous.png == reused.png
                               and previous.source.origin == reused.source.origin
                               and previous.source.gray.tobytes() == reused.source.gray.tobytes())
            previous.source.gray.close()
            reused.source.gray.close()
    finally:
        source.close()
    ring = [(100, 100), (150, 100), (150, 150), (100, 150)]
    vectors = [DetectionVector(start={"x": 1000 + index % 100 * 20, "y": 1000 + index // 100 * 5},
                              end={"x": 1010 + index % 100 * 20, "y": 1000 + index // 100 * 5})
               for index in range(29996)]
    vectors.extend(DetectionVector(start={"x": a[0], "y": a[1]}, end={"x": b[0], "y": b[1]})
                   for a, b in zip(ring, ring[1:] + ring[:1]))
    index = VectorIndex(vectors)
    def build_index_and_fit():
        shared = VectorIndex(vectors)
        return [refine_ring(ring, shared) for _ in range(25)]
    prepared_page = prepare_image(original, Settings())
    context = PageContext(document_id="assessment", file_name=SOURCE.name, page_id="assessment", page_index=0,
                          source_image_hash=prepared_page.source_hash, source_width=width, source_height=height,
                          render_scale=2., render_rotation=0, render_version="performance-assessment",
                          pdf_view_box=[0., 0., width / 2, height / 2])
    class FrozenProvider:
        ready = True
        def __init__(self):
            self.active, self.peak = 0, 0
        async def generate(self, image, prompt, schema):
            self.active += 1
            self.peak = max(self.active, self.peak)
            try:
                await asyncio.sleep(.2)
                return ProviderResult("[]")
            finally:
                self.active -= 1
        async def close(self):
            pass
    async def mocked_run(concurrency):
        provider = FrozenProvider()
        service = RoiService(Settings(storage_backend="memory", penetration_crop_concurrency=concurrency), provider)
        page = PageRecord(context, prepared_page, service.clock() + 600)
        session = Session(service.clock() + 600)
        session.pages[context.page_id] = page
        run_settings = {}
        started = perf_counter()
        try:
            annotations, status, warnings, attempts = await scan_penetrations(service, session, page,
                request, "Return [] in FIRST-image coordinates.", run_settings)
            return {"elapsed_seconds": round(perf_counter() - started, 4), "peak_provider_calls": provider.peak,
                    "attempts": attempts, "completed_crops": run_settings["completed_crops"],
                    "annotations": len(annotations), "status": status, "warnings": warnings}
        finally:
            await service.close()
    results = {
        "source": str(SOURCE), "renderer": "PyMuPDF scale=2; approximates PDF.js source workload",
        "raster_size": [width, height], "original_png_bytes": len(original),
        "scope": "full page upper-bound example; actual accepted outline unavailable",
        "crops": len(crops), "crop_limit_reached": limited,
        "upload_prepare": timed(lambda: prepare_image(original, Settings())),
        "all_crop_prepare": timed(prepare_all),
        "reused_source_all_crop_prepare_including_decode": timed(prepare_reused),
        "all_crop_png_metadata_and_fitting_raster_identical": all(crop_parity),
        "vector_filter_and_fit_25_proposals_30000_segments": timed(lambda: [refine_ring(ring, vectors) for _ in range(25)]),
        "vector_index_build_30000_segments": timed(lambda: VectorIndex(vectors)),
        "vector_index_build_plus_fit_25_proposals": timed(build_index_and_fit),
        "prebuilt_vector_index_fit_25_proposals": timed(lambda: [refine_ring(ring, index) for _ in range(25)]),
        "vector_fit_result_identical": refine_ring(ring, vectors) == refine_ring(ring, index),
        "local_vectors_fit_25_proposals_4_segments": timed(lambda: [refine_ring(ring, vectors[-4:]) for _ in range(25)]),
        "mocked_provider_note": "Current scheduler, fixed 0.2-second empty provider result, memory storage, six real PDF crop preparations; not live-model speedup",
        "mocked_scheduler_serial": asyncio.run(mocked_run(1)),
        "mocked_scheduler_four_workers": asyncio.run(mocked_run(4)),
        "live_model_calls": 0,
    }
    (OUT / "implemented-timings.json").write_text(json.dumps(results, indent=2), encoding="utf-8")
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
