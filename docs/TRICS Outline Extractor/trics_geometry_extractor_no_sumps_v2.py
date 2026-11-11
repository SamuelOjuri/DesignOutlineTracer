#!/usr/bin/env python3
"""Extract only roof boundary polygons, protrusion polygons and outlet centres
from a TRICS project (.trics). Sump Definitions are intentionally excluded.

Outputs:
  <input-stem>_roof_protrusions_outlets.json
  <input-stem>_roof_protrusions_outlets.dxf

Install: pip install lxml shapely ezdxf
Usage: python extract_trics_roof_protrusions_outlets.py "AX19010_26.01 - A.trics"
       python extract_trics_roof_protrusions_outlets.py myfile.trics --output-dir ./export

The TRICS format is proprietary; the mappings below were verified against
AX19010_26.01 - A.trics. Validate other project files before production use.
This script reads the source file but never modifies it.
"""

import argparse
import gzip
import json
from pathlib import Path

import ezdxf
from lxml import etree
from shapely.geometry import Point, Polygon
from shapely.ops import unary_union

# TRICS entity types used for this extraction. In particular, type 7002
# (Sump Definitions) is NOT included or processed.
ENTITY_TYPES = {
    "7001": ("roof_boundaries", "Roof Definitions", "ROOF_BOUNDARIES"),
    "7004": ("protrusions", "Protrusion Definitions", "PROTRUSIONS"),
    "7012": ("outlet_centres", "Outlets", "OUTLET_CENTRES"),
}


def load_trics_xml(path: Path):
    raw = path.read_bytes()
    # In the verified example a 10-byte container prefix precedes gzip data.
    gzip_offset = raw.find(b"\x1f\x8b\x08")
    if gzip_offset < 0:
        raise ValueError("No gzip-compressed TRICS payload found in the project file")
    try:
        payload = gzip.decompress(raw[gzip_offset:])
        parser = etree.XMLParser(resolve_entities=False, no_network=True)
        root = etree.fromstring(payload, parser=parser)
    except (OSError, etree.XMLSyntaxError) as exc:
        raise ValueError(f"Unable to decode TRICS XML: {exc}") from exc
    if etree.QName(root).localname != "TRICS":
        raise ValueError(f"Unexpected root element: {root.tag}")
    return root


def parse_polygon(entity):
    segments = []
    vertices = []
    for segment in entity.findall("./Segments/Segment"):
        start = [float(segment.get("Point1_x")), float(segment.get("Point1_y"))]
        end = [float(segment.get("Point2_x")), float(segment.get("Point2_y"))]
        details = {
            k: v for k, v in segment.attrib.items()
            if k not in ("Point1_x", "Point1_y", "Point1_z",
                         "Point2_x", "Point2_y", "Point2_z", "EntityType")
        }
        segments.append({"start_mm": start, "end_mm": end, **details})
        vertices.append(start)

    if len(vertices) < 3:
        raise ValueError(f"Polygon entity {entity.get('Handle')} has fewer than 3 vertices")

    # A closed chain need not repeat the first vertex at the end.
    for i, segment in enumerate(segments):
        next_start = segments[(i + 1) % len(segments)]["start_mm"]
        if any(abs(a - b) > 1e-6 for a, b in zip(segment["end_mm"], next_start)):
            raise ValueError(f"Polygon entity {entity.get('Handle')} is not a closed chain")

    polygon = Polygon(vertices)
    if not polygon.is_valid or polygon.area <= 0:
        raise ValueError(f"Polygon entity {entity.get('Handle')} is invalid")
    return vertices, segments, polygon


def extract(source: Path, output_dir: Path):
    root = load_trics_xml(source)
    entities = root.find("Entities")
    if entities is None:
        raise ValueError("TRICS XML contains no Entities collection")
    project = root.find("ProjectData")

    result = {
        "source": source.name,
        "project_reference": project.get("DrawingReference") if project is not None else None,
        "revision": project.get("Revision") if project is not None else None,
        "coordinate_system": {
            "type": "CAD Cartesian XY", "units": "millimetres",
            "georeferenced": False, "y_axis": "up",
        },
        "geometry": {
            "roof_boundaries": [],
            "protrusions": [],
            "outlet_centres": [],
        },
        "notes": [
            "Native TRICS entities; no image tracing or PDF reconstruction.",
            "Protrusion polygons may represent various obstructions; verify physical identity.",
            "Outlet centres are original point coordinates; no sump geometry is extracted.",
            "Outlet points outside roof boundaries are preserved without relocation.",
            "TRICS entity mapping verified against one project, not all versions.",
        ],
    }

    dxf = ezdxf.new("R2010")
    dxf.header["$INSUNITS"] = 4   # millimetres
    dxf.header["$MEASUREMENT"] = 1
    dxf.header["$PDMODE"] = 3      # display DXF POINT entities as crosshairs
    dxf.header["$PDSIZE"] = 0      # display size proportional to viewport
    msp = dxf.modelspace()
    for layer, colour in (("ROOF_BOUNDARIES", 3), ("PROTRUSIONS", 1),
                          ("OUTLET_CENTRES", 4)):
        dxf.layers.new(layer, dxfattribs={"color": colour})

    roof_polygons = []
    protrusion_polygons = []
    for entity in entities:
        entity_type = entity.get("EntityType")
        if entity_type not in ENTITY_TYPES:
            continue   # Other entities, including sump definitions, are ignored.

        category, source_layer, dxf_layer = ENTITY_TYPES[entity_type]
        index = len(result["geometry"][category]) + 1
        record = {
            "id": f"{category}_{index:02d}",
            "source_handle": entity.get("Handle"),
            "source_layer": source_layer,
        }

        if entity_type == "7012":
            position = entity.find("{*}Position")
            if position is None:
                raise ValueError(f"Outlet entity {entity.get('Handle')} has no Position")
            x = float(position.findtext("{*}X"))
            y = float(position.findtext("{*}Y"))
            record.update({"geometry_type": "Point", "position_mm": [x, y]})
            msp.add_point((x, y), dxfattribs={"layer": dxf_layer})
        else:
            vertices, segments, shape = parse_polygon(entity)
            record.update({
                "geometry_type": "Polygon", "closed": True,
                "vertices_mm": vertices,
                "area_m2": round(shape.area / 1_000_000, 6),
                "segment_details": segments,
            })
            if entity_type == "7001":
                record["group_name"] = entity.get("GroupName")
                roof_polygons.append((record, shape))
            else:
                record["edge_as_perimeter"] = entity.get("EdgeAsPerimeter")
                protrusion_polygons.append((record, shape))
            msp.add_lwpolyline(vertices, close=True, dxfattribs={"layer": dxf_layer})

        result["geometry"][category].append(record)

    # Associate geometry with roof footprints without changing native coordinates.
    for record, shape in protrusion_polygons:
        record["roof_overlap_fractions"] = [
            {"roof_id": roof["id"], "fraction": round(shape.intersection(rshape).area / shape.area, 6)}
            for roof, rshape in roof_polygons
            if shape.intersection(rshape).area > 0
        ]

    for record in result["geometry"]["outlet_centres"]:
        point = Point(record["position_mm"])
        record["within_roofs"] = [
            roof["id"] for roof, shape in roof_polygons if shape.covers(point)
        ]
        if roof_polygons:
            nearest_roof, nearest_shape = min(roof_polygons, key=lambda item: item[1].distance(point))
            record["nearest_roof_id"] = nearest_roof["id"]
            record["distance_to_nearest_roof_mm"] = round(nearest_shape.distance(point), 3)

    if roof_polygons:
        roof_union = unary_union([shape for _, shape in roof_polygons])
        protrusion_union = unary_union([shape for _, shape in protrusion_polygons]) if protrusion_polygons else None
        gross_m2 = round(roof_union.area / 1_000_000, 3)
        net_m2 = round(roof_union.difference(protrusion_union).area / 1_000_000, 3) if protrusion_union else gross_m2
    else:
        gross_m2 = net_m2 = 0.0

    result["summary"] = {
        "roof_boundary_count": len(roof_polygons),
        "protrusion_count": len(protrusion_polygons),
        "outlet_centre_count": len(result["geometry"]["outlet_centres"]),
        "gross_roof_area_m2": gross_m2,
        "roof_area_less_protrusions_m2": net_m2,
        "outlet_centres_outside_all_roofs": sum(
            not row["within_roofs"] for row in result["geometry"]["outlet_centres"]
        ),
    }

    output_dir.mkdir(parents=True, exist_ok=True)
    stem = f"{source.stem}_roof_protrusions_outlets"
    json_path = output_dir / f"{stem}.json"
    dxf_path = output_dir / f"{stem}.dxf"
    json_path.write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")
    dxf.saveas(dxf_path)
    print(json.dumps(result["summary"], indent=2))
    print(f"JSON: {json_path}")
    print(f"DXF:  {dxf_path}")
    return result, json_path, dxf_path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("trics_file", type=Path, help="Path to the input .trics project file")
    parser.add_argument("--output-dir", type=Path, help="Output folder (defaults to input file folder)")
    args = parser.parse_args()
    if not args.trics_file.is_file():
        parser.error(f"File not found: {args.trics_file}")
    extract(args.trics_file, args.output_dir or args.trics_file.parent)


if __name__ == "__main__":
    main()
