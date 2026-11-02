import type { RoofExportModel } from "./drawingExport";

export const TRICS_PROMPT_VERSION = "trics-prompt-v2";

export interface TricsPromptPaths {
  specification: string | null;
  details: string;
  roofPlans: string[];
  dxf: string;
  svg: string;
  geojson: string;
  metadata: string;
  drawingPng: string;
  maskPng: string;
  markedUp: string[];
}

const formatNumber = (value: number) => value.toLocaleString("en-GB", { maximumFractionDigits: 2, useGrouping: false });
const cell = (value: string) => value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

/**
 * Deterministic design brief for the AI-assisted CAD system. It points at the package files and never
 * copies values from the specification PDF or the form CSV, so each fact has a single source.
 */
export function buildTricsPrompt(model: RoofExportModel, paths: TricsPromptPaths, generatedAt: string): string {
  const roofLabel = new Map(model.roof_areas.map(area => [area.id, area.label]));
  const lines: string[] = [
    "# TRICS roof design brief",
    "",
    `Generated ${generatedAt} by TaperedPlus XPress. Template \`${TRICS_PROMPT_VERSION}\`; drawing export \`${model.version}\`.`,
    "",
    "## Objective",
    "",
    "Design a tapered roof insulation scheme for the roof area(s) in this package. The design must meet the performance",
    "specification and drain every part of each roof area to the outlets and drainage edges shown in the drawing.",
    "",
    "## Package contents",
    "",
    "| File | Use |",
    "| --- | --- |",
    paths.specification
      ? `| \`${cell(paths.specification)}\` | Performance specification document, included exactly as received. |`
      : "| _(none)_ | No performance specification document was supplied with this package. |",
    `| \`${paths.details}\` | Additional project details entered manually in TaperedPlus XPress. Columns: \`field_key\`, \`field_label\`, \`value\`; a blank value means the field was not entered. |`,
    ...paths.roofPlans.map(path => `| \`${cell(path)}\` | Original roof plan PDF, unmodified. Use for context, notes and labels. |`),
    `| \`${paths.dxf}\` | **Primary geometry.** AutoCAD R12 DXF in millimetres. Layers: ROOF_OUTLINE, CUTOUTS, PENETRATIONS, DRAINAGE_EDGES, OUTLETS, OUTLETS_UNCONFIRMED, LABELS. |`,
    `| \`${paths.geojson}\` | The same geometry as GeoJSON in local millimetres (not WGS84), with roof-area, opening, outlet and drainage-edge properties. |`,
    `| \`${paths.metadata}\` | Geometry metadata: scale basis, source pages, areas, perimeters, outlet diameters and notes. |`,
    `| \`${paths.svg}\` | True-scale vector drawing (1 unit = 1 mm). |`,
    `| \`${paths.drawingPng}\` | Raster image of the roof layout as reviewed in TaperedPlus XPress. |`,
    `| \`${paths.maskPng}\` | Black-and-white mask of the insulated area; its pixel-to-millimetre mapping is \`mask_png\` in the metadata. |`,
    ...paths.markedUp.map(path => `| \`${cell(path)}\` | Roof plan page with the requested area of interest highlighted in red and outlets in blue. |`),
    "",
    "## How to use the sources",
    "",
    ...(paths.specification ? [
      "1. The performance specification document is the source for the performance requirements: target U-values,",
      "   tapered insulation, membrane, VCL and decking. Map its wording to your own product and build-up options.",
    ] : [
      "1. No performance specification document was supplied, so the performance requirements (target U-values,",
      "   tapered insulation, membrane, VCL and decking) are not known.",
    ]),
    "2. The project details CSV holds the other project details entered in TaperedPlus XPress, such as contact, project",
    "   address, maximum insulation height, fall type and build method.",
    "3. Where a requirement is not given, state the assumption you used.",
    "4. Take geometry from the drawing files. Use the roof plan PDF and marked-up page images only for context.",
    "",
    "## Geometry summary",
    "",
    `- Units: millimetres; x to the right, y up; origin at the ${model.origin}.`,
    `- Overall extent: ${formatNumber(model.width_mm)} mm x ${formatNumber(model.height_mm)} mm.`,
    `- Roof areas: ${model.totals.roof_areas}; gross ${formatNumber(model.totals.gross_area_m2)} m², net of openings ${formatNumber(model.totals.net_area_m2)} m².`,
    `- Openings: ${model.totals.penetrations} penetration(s), ${model.totals.cutouts} cutout(s). Do not insulate openings; keep water flowing around them.`,
    `- Outlets: ${model.totals.outlets}; drainage edges: ${model.totals.drainage_edges}.`,
    "",
    "| Roof area | Gross m² | Net m² | Perimeter m |",
    "| --- | ---: | ---: | ---: |",
    ...model.roof_areas.map(area => `| ${area.label} | ${formatNumber(area.gross_area_m2)} | ${formatNumber(area.net_area_m2)} | ${formatNumber(area.perimeter_m)} |`),
  ];

  if (model.outlets.length) {
    lines.push("", "| Outlet | Roof area | x mm | y mm | Diameter mm | Diameter confirmed |", "| --- | --- | ---: | ---: | ---: | --- |",
      ...model.outlets.map(outlet => `| ${outlet.label} | ${outlet.roof_area_id ? roofLabel.get(outlet.roof_area_id) ?? "-" : "outside roof areas"} | ${formatNumber(outlet.position.x)} | ${formatNumber(outlet.position.y)} | ${formatNumber(outlet.diameter_mm)} | ${outlet.diameter_confirmed ? "yes" : "no (application default)"} |`));
  }
  if (model.drainage_edges.length) {
    lines.push("", "Drainage edges (water discharges over these edges, for example into a gutter):", "",
      ...model.drainage_edges.map(edge => `- ${roofLabel.get(edge.roof_area_id) ?? edge.roof_area_id}, edge ${edge.edge_index + 1}: (${formatNumber(edge.start.x)}, ${formatNumber(edge.start.y)}) to (${formatNumber(edge.end.x)}, ${formatNumber(edge.end.y)}), ${formatNumber(edge.length_m)} m.`));
  }

  lines.push(
    "",
    "## Design requirements",
    "",
    "- Achieve the target U-value given in the performance specification document across the insulated area, and any",
    "  minimum U-value given.",
    "- Provide falls that carry water from every part of each roof area to its outlets or drainage edges, with no ponding",
    "  areas. Use the fall type given in the project details CSV; if none is given, state the fall you used.",
    "- Respect any maximum insulation height and build method given in the project details CSV.",
    "- Keep the supplied outline, origin and units so the design overlays the supplied DXF exactly.",
    "",
    "## Known limitations",
    "",
    ...model.notes.map(note => `- ${note}`),
    "",
    "## Expected output",
    "",
    "1. A tapered insulation layout drawing (DXF) aligned to the supplied geometry.",
    "2. A board schedule with quantities.",
    "3. A U-value calculation summary showing the achieved average and minimum values.",
    "4. A list of assumptions made and items needing confirmation.",
    "",
  );
  return lines.join("\n");
}
