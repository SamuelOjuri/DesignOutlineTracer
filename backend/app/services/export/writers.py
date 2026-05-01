import json
from pathlib import Path

import ezdxf
import svgwrite
from PIL import Image, ImageDraw
from shapely.geometry import Polygon, mapping

from app.models.production import ExportFormat, ExportPaths, ProductionSchema


def write_exports(
    *,
    production_schema: ProductionSchema,
    export_directory: Path,
    formats: list[ExportFormat],
) -> ExportPaths:
    export_directory.mkdir(parents=True, exist_ok=True)
    paths = ExportPaths()

    if "dxf" in formats:
        paths.dxf = _write_dxf(production_schema, export_directory / "roof_scope_outline.dxf").name
    if "svg" in formats:
        paths.svg = _write_svg(production_schema, export_directory / "roof_scope_overlay.svg").name
    if "geojson" in formats:
        paths.geojson = _write_geojson(
            production_schema, export_directory / "roof_scope.geojson"
        ).name
    if "mask_png" in formats:
        paths.mask_png = _write_mask_png(
            production_schema, export_directory / "roof_scope_mask.png"
        ).name
    if "metadata_json" in formats:
        metadata_path = export_directory / "roof_scope_metadata.json"
        paths.metadata_json = metadata_path.name

    production_schema.exports = paths
    if "metadata_json" in formats:
        (export_directory / "roof_scope_metadata.json").write_text(
            production_schema.model_dump_json(indent=2),
            encoding="utf-8",
        )
    return paths


def _write_dxf(schema: ProductionSchema, path: Path) -> Path:
    doc = ezdxf.new("R2010")  # type: ignore[attr-defined]
    modelspace = doc.modelspace()
    doc.layers.add("TARGET_AREA", color=1)
    doc.layers.add("ROOFLIGHTS", color=3)
    doc.layers.add("OUTLETS", color=5)

    outline = [(point[0], -point[1]) for point in schema.target_area.outer_polygon_mm]
    modelspace.add_lwpolyline(outline, close=True, dxfattribs={"layer": "TARGET_AREA"})

    for rooflight in schema.constraints.rooflights:
        points = [(point[0], -point[1]) for point in rooflight.polygon_mm]
        modelspace.add_lwpolyline(points, close=True, dxfattribs={"layer": "ROOFLIGHTS"})

    for outlet in schema.constraints.rainwater_outlets:
        modelspace.add_circle(
            center=(outlet.point_mm[0], -outlet.point_mm[1]),
            radius=75,
            dxfattribs={"layer": "OUTLETS"},
        )

    doc.saveas(path)
    return path


def _write_svg(schema: ProductionSchema, path: Path) -> Path:
    polygon = Polygon(schema.target_area.outer_polygon_mm)
    minx, miny, maxx, maxy = polygon.bounds
    width = max(maxx - minx, 1)
    height = max(maxy - miny, 1)
    drawing = svgwrite.Drawing(str(path), size=(f"{width}mm", f"{height}mm"))
    drawing.viewbox(minx, miny, width, height)
    drawing.add(
        drawing.polygon(
            points=schema.target_area.outer_polygon_mm,
            fill="#ef4444",
            fill_opacity=0.15,
            stroke="#ef4444",
            stroke_width=50,
        )
    )
    for rooflight in schema.constraints.rooflights:
        drawing.add(
            drawing.polygon(
                points=rooflight.polygon_mm,
                fill="#22c55e",
                fill_opacity=0.2,
                stroke="#22c55e",
                stroke_width=30,
            )
        )
    for outlet in schema.constraints.rainwater_outlets:
        drawing.add(
            drawing.circle(
                center=outlet.point_mm,
                r=90,
                fill="#3b82f6",
                stroke="#1d4ed8",
                stroke_width=20,
            )
        )
    drawing.save()
    return path


def _write_geojson(schema: ProductionSchema, path: Path) -> Path:
    polygon = Polygon(schema.target_area.outer_polygon_mm)
    payload = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {
                    "id": schema.target_area.id,
                    "area_m2": schema.target_area.area_m2_estimated,
                },
                "geometry": mapping(polygon),
            }
        ],
    }
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return path


def _write_mask_png(schema: ProductionSchema, path: Path) -> Path:
    polygon = Polygon(schema.target_area.outer_polygon_mm)
    minx, miny, maxx, maxy = polygon.bounds
    scale = min(1200 / max(maxx - minx, 1), 1200 / max(maxy - miny, 1))
    width = max(1, int((maxx - minx) * scale) + 20)
    height = max(1, int((maxy - miny) * scale) + 20)
    image = Image.new("L", (width, height), 0)
    draw = ImageDraw.Draw(image)
    points = [
        ((x - minx) * scale + 10, (y - miny) * scale + 10)
        for x, y in polygon.exterior.coords
    ]
    draw.polygon(points, fill=255)
    image.save(path)
    return path
