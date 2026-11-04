import polygonClipping, { type Polygon } from "polygon-clipping";
import type { Point } from "@/types/roof";
import type { PageSession } from "@/types/roi";
import { combinePageDrawings, mmPerPixel, type CombinedDrawing } from "./roiDrawing";
import { OUTLET_COLOUR } from "./outletMarker";
import { DEFAULT_OUTLET_DIAMETER_MM } from "./outletDefaults";

export const DRAWING_EXPORT_VERSION = "tpid-drawing-v1";

export interface ExportSource {
  document_id: string;
  file_name: string;
  page_id: string;
  page_index: number;
  paper_size: string;
  scale_ratio: number;
  mm_per_pixel: number;
  source_width_px: number;
  source_height_px: number;
}

export interface ExportRoofArea {
  id: string;
  label: string;
  page_id: string;
  roi_id: string | null;
  outline: Point[];
  gross_area_m2: number;
  net_area_m2: number;
  perimeter_m: number;
}

export interface ExportOpening {
  id: string;
  label: string;
  kind: "cutout" | "penetration";
  page_id: string;
  roi_id: string | null;
  roof_area_id: string | null;
  outline: Point[];
  area_m2: number;
}

export interface ExportOutlet {
  id: string;
  label: string;
  page_id: string;
  roof_area_id: string | null;
  position: Point;
  diameter_mm: number;
  diameter_confirmed: boolean;
  origin: "manual" | "detected";
  subtype: string | null;
}

export interface ExportDrainageEdge {
  roof_area_id: string;
  edge_index: number;
  start: Point;
  end: Point;
  length_m: number;
}

/** Real-world geometry in millimetres, x to the right and y up from the bottom-left of the roof bounds. */
export interface RoofExportModel {
  version: typeof DRAWING_EXPORT_VERSION;
  units: "mm";
  axes: "x-right-y-up";
  origin: "bottom-left of the exported roof bounds";
  width_mm: number;
  height_mm: number;
  mm_per_drawing_unit: number;
  sources: ExportSource[];
  roof_areas: ExportRoofArea[];
  openings: ExportOpening[];
  outlets: ExportOutlet[];
  drainage_edges: ExportDrainageEdge[];
  totals: {
    roof_areas: number;
    gross_area_m2: number;
    net_area_m2: number;
    penetrations: number;
    cutouts: number;
    outlets: number;
    unconfirmed_outlet_diameters: number;
    drainage_edges: number;
  };
  notes: string[];
}

export interface RoofExport {
  model: RoofExportModel;
  /** The same combined drawing shown on Project Details, in drawing units, for raster rendering. */
  drawing: CombinedDrawing;
}

const round = (value: number, places = 1) => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

function signedArea(ring: Point[]): number {
  let sum = 0;
  ring.forEach((point, index) => {
    const next = ring[(index + 1) % ring.length];
    sum += point.x * next.y - next.x * point.y;
  });
  return sum / 2;
}

function perimeter(ring: Point[]): number {
  return ring.reduce((total, point, index) => {
    const next = ring[(index + 1) % ring.length];
    return total + Math.hypot(next.x - point.x, next.y - point.y);
  }, 0);
}

function inRing(point: Point, ring: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.y > point.y) !== (b.y > point.y)
      && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function centroid(ring: Point[]): Point {
  return { x: ring.reduce((sum, point) => sum + point.x, 0) / ring.length,
    y: ring.reduce((sum, point) => sum + point.y, 0) / ring.length };
}

const clippingPolygon = (ring: Point[]): Polygon => [ring.map(({ x, y }) => [x, y])];

function multiPolygonArea(polygons: Polygon[]): number {
  return polygons.reduce((total, polygon) => total + polygon.reduce((sum, ring, index) => {
    const area = Math.abs(signedArea(ring.slice(0, -1).map(([x, y]) => ({ x, y }))));
    return index === 0 ? sum + area : sum - area;
  }, 0), 0);
}

function netArea(outline: Point[], holes: Point[][]): number {
  const gross = Math.abs(signedArea(outline));
  const cuts = holes.filter(hole => hole.length >= 3);
  if (!cuts.length) return gross;
  try {
    return multiPolygonArea(polygonClipping.difference(clippingPolygon(outline), ...cuts.map(clippingPolygon)));
  } catch {
    return Math.max(0, gross - cuts.reduce((sum, hole) => sum + Math.abs(signedArea(hole)), 0));
  }
}

/** Builds the exportable roof model from the same combined layout shown on Project Details. */
export function buildRoofExport(pages: PageSession[], pageOffsets: Record<string, Point> = {}): RoofExport | null {
  const drawing = combinePageDrawings(pages, pageOffsets);
  const outlines = drawing.roofOutlines.filter(outline => outline.length >= 3);
  if (!outlines.length || !drawing.mmPerPixel) return null;
  const scale = drawing.mmPerPixel;
  const extentPoints = [...drawing.roofOutlines.flat(), ...drawing.interiorHoles.flat(), ...drawing.outlets];
  const minX = Math.min(...extentPoints.map(point => point.x));
  const maxX = Math.max(...extentPoints.map(point => point.x));
  const minY = Math.min(...extentPoints.map(point => point.y));
  const maxY = Math.max(...extentPoints.map(point => point.y));
  const toMm = (point: Point): Point => ({ x: round((point.x - minX) * scale), y: round((maxY - point.y) * scale) });

  const roofRings = drawing.roofOutlines.map(outline => outline.map(toMm));
  const holeRings = drawing.interiorHoles.map(hole => hole.map(toMm));
  const roofIndexAt = (point: Point) => roofRings.findIndex(ring => ring.length >= 3 && inRing(point, ring));

  const openingCounts = { cutout: 0, penetration: 0 };
  const openings: ExportOpening[] = holeRings.map((ring, index) => {
    const reference = drawing.holeRefs[index];
    const kind = reference?.id.startsWith("penetration:") ? "penetration" : "cutout";
    openingCounts[kind] += 1;
    const owner = ring.length >= 3 ? roofIndexAt(centroid(ring)) : -1;
    return { id: reference?.id ?? `opening-${index + 1}`, kind,
      label: `${kind === "penetration" ? "Penetration" : "Cutout"} ${openingCounts[kind]}`,
      page_id: reference?.page_id ?? "", roi_id: reference?.roi_id ?? null,
      roof_area_id: owner >= 0 ? drawing.outlineRefs[owner]?.id ?? null : null,
      outline: ring, area_m2: round(Math.abs(signedArea(ring)) / 1e6, 2) };
  });

  const roofAreas: ExportRoofArea[] = roofRings.map((ring, index) => {
    const reference = drawing.outlineRefs[index];
    const holes = holeRings.filter((_, holeIndex) => openings[holeIndex].roof_area_id === reference?.id);
    return { id: reference?.id ?? `roof-${index + 1}`, label: `Roof area ${index + 1}`, page_id: reference?.page_id ?? "",
      roi_id: reference?.roi_id ?? null, outline: ring,
      gross_area_m2: round(Math.abs(signedArea(ring)) / 1e6, 2),
      net_area_m2: round(netArea(ring, holes) / 1e6, 2),
      perimeter_m: round(perimeter(ring) / 1000, 2) };
  });

  const outlets: ExportOutlet[] = drawing.outlets.map((outlet, index) => {
    const position = toMm(outlet);
    const owned = outlet.outline_id ? drawing.outlineRefs.findIndex(reference => reference.id === outlet.outline_id) : -1;
    const owner = owned >= 0 ? owned : roofIndexAt(position);
    return { id: outlet.id, label: `Outlet ${index + 1}`, page_id: drawing.outletRefs[index]?.page_id ?? outlet.page_id ?? "",
      roof_area_id: owner >= 0 ? drawing.outlineRefs[owner]?.id ?? null : null, position,
      diameter_mm: round(outlet.diameter * 1000), diameter_confirmed: outlet.diameter_confirmed === true,
      origin: outlet.annotation_id ? "detected" : "manual", subtype: outlet.subtype ?? null };
  });

  const drainageEdges: ExportDrainageEdge[] = drawing.drainageEdges.flatMap(edge => {
    const ring = roofRings[edge.outlineIndex];
    const reference = drawing.outlineRefs[edge.outlineIndex];
    if (!ring || !reference || ring.length < 2) return [];
    const start = ring[edge.edgeIndex % ring.length];
    const end = ring[(edge.edgeIndex + 1) % ring.length];
    return [{ roof_area_id: reference.id, edge_index: edge.edgeIndex, start, end,
      length_m: round(Math.hypot(end.x - start.x, end.y - start.y) / 1000, 2) }];
  });

  const populated = pages.filter(page => page.drawing.outlines.some(outline => outline.points.length > 0));
  const sources: ExportSource[] = populated.map(page => ({
    document_id: page.source.document_id, file_name: page.source.file_name, page_id: page.source.page_id,
    page_index: page.source.page_index, paper_size: page.drawing.drawing_scale.paperSize,
    scale_ratio: page.drawing.drawing_scale.scaleRatio, mm_per_pixel: mmPerPixel(page),
    source_width_px: page.source.source_width, source_height_px: page.source.source_height,
  }));

  const unconfirmed = outlets.filter(outlet => !outlet.diameter_confirmed).length;
  const notes = [
    `Dimensions are derived from the paper size and drawing scale chosen at upload (${sources
      .map(source => `${source.paper_size} @ 1:${source.scale_ratio}`).join(", ")}); check against a known dimension.`,
  ];
  if (sources.length > 1) notes.push("Roof areas from different PDF pages are placed side by side or as arranged on Project Details; their relative positions are illustrative, not surveyed.");
  if (unconfirmed) notes.push(`${unconfirmed} outlet diameter(s) use the unconfirmed ${DEFAULT_OUTLET_DIAMETER_MM} mm application default.`);
  const unassigned = outlets.filter(outlet => !outlet.roof_area_id).length;
  if (unassigned) notes.push(`${unassigned} outlet(s) are not inside a roof area.`);

  return { drawing, model: {
    version: DRAWING_EXPORT_VERSION, units: "mm", axes: "x-right-y-up", origin: "bottom-left of the exported roof bounds",
    width_mm: round((maxX - minX) * scale), height_mm: round((maxY - minY) * scale), mm_per_drawing_unit: scale,
    sources, roof_areas: roofAreas, openings, outlets, drainage_edges: drainageEdges,
    totals: {
      roof_areas: roofAreas.length,
      gross_area_m2: round(roofAreas.reduce((sum, area) => sum + area.gross_area_m2, 0), 2),
      net_area_m2: round(roofAreas.reduce((sum, area) => sum + area.net_area_m2, 0), 2),
      penetrations: openingCounts.penetration, cutouts: openingCounts.cutout, outlets: outlets.length,
      unconfirmed_outlet_diameters: unconfirmed, drainage_edges: drainageEdges.length,
    },
    notes,
  } };
}

const DXF_LAYERS: [name: string, colour: number][] = [
  ["ROOF_OUTLINE", 7], ["CUTOUTS", 8], ["PENETRATIONS", 3], ["DRAINAGE_EDGES", 4],
  ["OUTLETS", 6], ["OUTLETS_UNCONFIRMED", 6], ["LABELS", 2],
];

/** AutoCAD R12 ASCII DXF in millimetres; readable by virtually every CAD package without handles. */
export function roofExportDxf(model: RoofExportModel): string {
  const lines: (string | number)[] = [];
  const pair = (code: number, value: string | number) => lines.push(code, typeof value === "number" ? round(value, 3) : value);
  const textHeight = Math.max(50, round(Math.max(model.width_mm, model.height_mm) / 80));
  const polyline = (layer: string, ring: Point[]) => {
    pair(0, "POLYLINE"); pair(8, layer); pair(66, 1); pair(10, 0); pair(20, 0); pair(30, 0); pair(70, 1);
    for (const point of ring) { pair(0, "VERTEX"); pair(8, layer); pair(10, point.x); pair(20, point.y); pair(30, 0); }
    pair(0, "SEQEND"); pair(8, layer);
  };
  const text = (point: Point, value: string) => {
    pair(0, "TEXT"); pair(8, "LABELS"); pair(10, point.x); pair(20, point.y); pair(30, 0); pair(40, textHeight); pair(1, value);
  };

  pair(0, "SECTION"); pair(2, "HEADER");
  pair(9, "$ACADVER"); pair(1, "AC1009");
  pair(9, "$INSUNITS"); pair(70, 4);
  pair(9, "$EXTMIN"); pair(10, 0); pair(20, 0); pair(30, 0);
  pair(9, "$EXTMAX"); pair(10, model.width_mm); pair(20, model.height_mm); pair(30, 0);
  pair(0, "ENDSEC");

  pair(0, "SECTION"); pair(2, "TABLES");
  pair(0, "TABLE"); pair(2, "LTYPE"); pair(70, 1);
  pair(0, "LTYPE"); pair(2, "CONTINUOUS"); pair(70, 0); pair(3, "Solid line"); pair(72, 65); pair(73, 0); pair(40, 0);
  pair(0, "ENDTAB");
  pair(0, "TABLE"); pair(2, "LAYER"); pair(70, DXF_LAYERS.length);
  for (const [name, colour] of DXF_LAYERS) { pair(0, "LAYER"); pair(2, name); pair(70, 0); pair(62, colour); pair(6, "CONTINUOUS"); }
  pair(0, "ENDTAB");
  pair(0, "ENDSEC");

  pair(0, "SECTION"); pair(2, "ENTITIES");
  for (const area of model.roof_areas) {
    if (area.outline.length < 3) continue;
    polyline("ROOF_OUTLINE", area.outline);
    text(centroid(area.outline), area.label);
  }
  for (const opening of model.openings) {
    if (opening.outline.length >= 3) polyline(opening.kind === "penetration" ? "PENETRATIONS" : "CUTOUTS", opening.outline);
  }
  for (const edge of model.drainage_edges) {
    pair(0, "LINE"); pair(8, "DRAINAGE_EDGES");
    pair(10, edge.start.x); pair(20, edge.start.y); pair(30, 0); pair(11, edge.end.x); pair(21, edge.end.y); pair(31, 0);
  }
  for (const outlet of model.outlets) {
    pair(0, "CIRCLE"); pair(8, outlet.diameter_confirmed ? "OUTLETS" : "OUTLETS_UNCONFIRMED");
    pair(10, outlet.position.x); pair(20, outlet.position.y); pair(30, 0); pair(40, outlet.diameter_mm / 2);
    text({ x: outlet.position.x + outlet.diameter_mm / 2, y: outlet.position.y + outlet.diameter_mm / 2 }, outlet.label);
  }
  pair(0, "ENDSEC");
  pair(0, "EOF");

  const output: string[] = [];
  for (let index = 0; index < lines.length; index += 2) output.push(String(lines[index]).padStart(3, " "), String(lines[index + 1]));
  return `${output.join("\r\n")}\r\n`;
}

const xml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** True-scale SVG: one user unit is one millimetre; y is flipped back to the screen convention. */
export function roofExportSvg(model: RoofExportModel): string {
  const padding = round(Math.max(model.width_mm, model.height_mm, 1) * 0.03);
  const stroke = round(Math.max(model.width_mm, model.height_mm, 1) / 500, 2);
  const flip = (point: Point) => `${point.x},${round(model.height_mm - point.y)}`;
  const path = (ring: Point[]) => `M ${ring.map(flip).join(" L ")} Z`;
  const width = round(model.width_mm + padding * 2);
  const height = round(model.height_mm + padding * 2);
  const body = [
    `<rect x="${-padding}" y="${-padding}" width="${width}" height="${height}" fill="#ffffff"/>`,
    `<g id="roof-areas" fill="#f2f2f2" stroke="#3d4452" stroke-width="${stroke}" stroke-linejoin="round">`,
    ...model.roof_areas.map(area => `  <path data-id="${xml(area.id)}" data-label="${xml(area.label)}" d="${path(area.outline)}"/>`),
    "</g>",
    `<g id="openings" fill="#ffffff" stroke="#666666" stroke-width="${stroke * 0.8}">`,
    ...model.openings.map(opening => `  <path data-id="${xml(opening.id)}" data-kind="${opening.kind}" data-label="${xml(opening.label)}" d="${path(opening.outline)}"/>`),
    "</g>",
    `<g id="drainage-edges" stroke="#1a80e6" stroke-width="${stroke * 1.6}" stroke-linecap="round">`,
    ...model.drainage_edges.map(edge => {
      const [x1, y1] = flip(edge.start).split(","), [x2, y2] = flip(edge.end).split(",");
      return `  <line data-roof-area="${xml(edge.roof_area_id)}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
    }),
    "</g>",
    `<g id="outlets" fill="none" stroke="${OUTLET_COLOUR}" stroke-width="${stroke}">`,
    ...model.outlets.map(outlet => {
      const [x, y] = flip(outlet.position).split(",").map(Number);
      const radius = outlet.diameter_mm / 2;
      const dash = outlet.diameter_confirmed ? "" : ` stroke-dasharray="${stroke * 2} ${stroke * 1.5}"`;
      return `  <g data-id="${xml(outlet.id)}" data-label="${xml(outlet.label)}" data-diameter-mm="${outlet.diameter_mm}" data-diameter-confirmed="${outlet.diameter_confirmed}"><circle cx="${x}" cy="${y}" r="${radius}"${dash}/><path d="M ${round(x - radius)},${y} L ${round(x + radius)},${y} M ${x},${round(y - radius)} L ${x},${round(y + radius)}"/></g>`;
    }),
    "</g>",
  ];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}mm" height="${height}mm" viewBox="${-padding} ${-padding} ${width} ${height}">`,
    "<title>Roof outline</title>",
    `<desc>Units: millimetres (1 user unit = 1 mm). ${xml(DRAWING_EXPORT_VERSION)}.</desc>`,
    ...body,
    "</svg>",
    "",
  ].join("\n");
}

const closed = (ring: Point[], counterClockwise: boolean) => {
  const oriented = (signedArea(ring) > 0) === counterClockwise ? ring : [...ring].reverse();
  return [...oriented, oriented[0]].map(point => [point.x, point.y]);
};

/** GeoJSON in local planar millimetres (not WGS84); exterior rings counter-clockwise per RFC 7946. */
export function roofExportGeoJson(model: RoofExportModel): string {
  const features = [
    ...model.roof_areas.filter(area => area.outline.length >= 3).map(area => ({
      type: "Feature", id: area.id,
      properties: { kind: "roof_area", label: area.label, page_id: area.page_id, roi_id: area.roi_id,
        gross_area_m2: area.gross_area_m2, net_area_m2: area.net_area_m2, perimeter_m: area.perimeter_m },
      geometry: { type: "Polygon", coordinates: [closed(area.outline, true),
        ...model.openings.filter(opening => opening.roof_area_id === area.id && opening.outline.length >= 3)
          .map(opening => closed(opening.outline, false))] },
    })),
    ...model.openings.filter(opening => opening.outline.length >= 3).map(opening => ({
      type: "Feature", id: opening.id,
      properties: { kind: opening.kind, label: opening.label, roof_area_id: opening.roof_area_id, area_m2: opening.area_m2 },
      geometry: { type: "Polygon", coordinates: [closed(opening.outline, true)] },
    })),
    ...model.outlets.map(outlet => ({
      type: "Feature", id: outlet.id,
      properties: { kind: "outlet", label: outlet.label, roof_area_id: outlet.roof_area_id, diameter_mm: outlet.diameter_mm,
        diameter_confirmed: outlet.diameter_confirmed, origin: outlet.origin, subtype: outlet.subtype },
      geometry: { type: "Point", coordinates: [outlet.position.x, outlet.position.y] },
    })),
    ...model.drainage_edges.map(edge => ({
      type: "Feature",
      properties: { kind: "drainage_edge", roof_area_id: edge.roof_area_id, edge_index: edge.edge_index, length_m: edge.length_m },
      geometry: { type: "LineString", coordinates: [[edge.start.x, edge.start.y], [edge.end.x, edge.end.y]] },
    })),
  ];
  return `${JSON.stringify({ type: "FeatureCollection",
    tpid: { version: model.version, units: model.units, axes: model.axes, crs: "local planar millimetres, not WGS84" },
    features }, null, 2)}\n`;
}

export function roofExportMetadata(model: RoofExportModel, generatedAt: string): string {
  return `${JSON.stringify({ generated_at: generatedAt, ...model, mask_png: maskLayout(model) }, null, 2)}\n`;
}

export interface MaskLayout {
  width_px: number;
  height_px: number;
  px_per_mm: number;
  margin_mm: number;
  /** Model coordinates (mm, y up) of the top-left corner of pixel (0, 0). */
  top_left_mm: Point;
  pixel_to_mm: string;
  values: string;
}

const MASK_LONG_EDGE_PX = 2048;

/** Raster mask geometry shared by the PNG renderer and the metadata so consumers can georeference it. */
export function maskLayout(model: RoofExportModel): MaskLayout {
  const margin = round(Math.max(model.width_mm, model.height_mm, 1) * 0.02);
  const width = model.width_mm + margin * 2, height = model.height_mm + margin * 2;
  const pxPerMm = MASK_LONG_EDGE_PX / Math.max(width, height, 1);
  return {
    width_px: Math.max(1, Math.round(width * pxPerMm)), height_px: Math.max(1, Math.round(height * pxPerMm)),
    px_per_mm: pxPerMm, margin_mm: margin, top_left_mm: { x: -margin, y: round(model.height_mm + margin) },
    pixel_to_mm: "x = top_left_mm.x + (column + 0.5) / px_per_mm; y = top_left_mm.y - (row + 0.5) / px_per_mm",
    values: "white = insulated roof area; black = outside the roof, cutouts and penetrations",
  };
}
