import type { DrainageEdge, Outlet, Point } from "@/types/roof";
import type { PageSession } from "@/types/roi";
import { drawOutletMarker, outletMarkerGeometries, OUTLET_COLOUR } from "./outletMarker";
import { penetrationOpenings } from "./penetrationOpenings";
import { activePageOutlets } from "./outletScope";
import { editorDrainage } from "./roiDrawing";
import { maskLayout, type RoofExportModel } from "./drawingExport";

export interface IllustrationData {
  roofOutlines: Point[][];
  outlineIds?: string[];
  interiorHoles: Point[][];
  outlets: Outlet[];
  drainageEdges: DrainageEdge[];
}

export interface IllustrationOptions {
  offset: Point;
  width: number;
  height: number;
  /** CSS zoom of the drawing; outlet glyphs are sized in screen pixels. */
  displayScale: number;
  hoveredOutline?: number | null;
  grid?: boolean;
}

export const ILLUSTRATION_PADDING = 60;

export function illustrationBounds(roofOutlines: Point[][], outlets: Point[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const outline of roofOutlines) {
    for (const p of outline) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
  }
  for (const o of outlets) {
    minX = Math.min(minX, o.x - 20);
    minY = Math.min(minY, o.y - 20);
    maxX = Math.max(maxX, o.x + 20);
    maxY = Math.max(maxY, o.y + 20);
  }
  if (!isFinite(minX)) return { minX: 0, minY: 0, maxX: 400, maxY: 300, w: 400, h: 300 };
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

function drawDrainageArrows(ctx: CanvasRenderingContext2D, p1: Point, p2: Point) {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len === 0) return;

  const nx = dx / len;
  const ny = dy / len;
  const px = ny;
  const py = -nx;

  const spacing = 30;
  const count = Math.max(1, Math.floor(len / spacing));

  ctx.strokeStyle = "hsl(210, 85%, 50%)";
  ctx.lineWidth = 1.5;

  for (let i = 0; i < count; i++) {
    const t = (i + 0.5) / count;
    const ax = p1.x + dx * t;
    const ay = p1.y + dy * t;
    const aLen = 10;
    const ex = ax + px * aLen;
    const ey = ay + py * aLen;

    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(ex, ey);
    ctx.stroke();

    const hl = 3.5;
    const angle = Math.atan2(py, px);
    const ha = Math.PI / 6;
    ctx.beginPath();
    ctx.moveTo(ex, ey);
    ctx.lineTo(ex - hl * Math.cos(angle - ha), ey - hl * Math.sin(angle - ha));
    ctx.moveTo(ex, ey);
    ctx.lineTo(ex - hl * Math.cos(angle + ha), ey - hl * Math.sin(angle + ha));
    ctx.stroke();
  }
}

function drawLegend(ctx: CanvasRenderingContext2D, canvasWidth: number, hasDrainage: boolean, hasOutlets: boolean) {
  const items: { color: string; label: string }[] = [
    { color: "hsl(220, 15%, 30%)", label: "Roof Edge" },
  ];
  if (hasDrainage) {
    items.push({ color: "hsl(210, 85%, 50%)", label: "Drainage Edge" });
  }
  if (hasOutlets) {
    items.push({ color: OUTLET_COLOUR, label: "Outlet" });
  }

  const x = canvasWidth - 14;
  let y = 20;
  ctx.textAlign = "right";
  ctx.font = "11px system-ui, sans-serif";

  for (const item of items) {
    ctx.fillStyle = item.color;
    ctx.fillRect(x - ctx.measureText(item.label).width - 18, y - 6, 12, 12);
    ctx.fillStyle = "hsl(220, 15%, 25%)";
    ctx.fillText(item.label, x, y + 4);
    y += 20;
  }
}

/** Shared by the Project Details canvas and the package PNG so both show the same drawing. */
export function drawRoofIllustration(ctx: CanvasRenderingContext2D, data: IllustrationData, options: IllustrationOptions) {
  const { roofOutlines, outlineIds = [], interiorHoles, outlets, drainageEdges } = data;
  const { offset, width, height, displayScale, hoveredOutline = null, grid = true } = options;
  const isDrainageEdge = (outlineIndex: number, edgeIndex: number) =>
    drainageEdges.some((edge) => edge.outlineIndex === outlineIndex && edge.edgeIndex === edgeIndex);

  // Clear with white
  ctx.fillStyle = "hsl(0, 0%, 100%)";
  ctx.fillRect(0, 0, width, height);

  if (grid) {
    ctx.strokeStyle = "hsl(0, 0%, 93%)";
    ctx.lineWidth = 0.5;
    const gridSize = 40;
    for (let x = 0; x < width; x += gridSize) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
    }
    for (let y = 0; y < height; y += gridSize) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
    }
  }

  for (let oi = 0; oi < roofOutlines.length; oi++) {
    const outline = roofOutlines[oi];
    if (outline.length < 3) continue;
    const isHovered = hoveredOutline === oi;

    ctx.fillStyle = isHovered ? "hsla(210, 80%, 90%, 0.6)" : "hsla(0, 0%, 95%, 0.8)";
    ctx.beginPath();
    ctx.moveTo(outline[0].x + offset.x, outline[0].y + offset.y);
    for (let i = 1; i < outline.length; i++) {
      ctx.lineTo(outline[i].x + offset.x, outline[i].y + offset.y);
    }
    ctx.closePath();
    ctx.fill();

    if (isHovered) {
      ctx.strokeStyle = "hsl(210, 85%, 55%)";
      ctx.lineWidth = 3;
      ctx.setLineDash([6, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    for (let ei = 0; ei < outline.length; ei++) {
      const p1 = outline[ei];
      const p2 = outline[(ei + 1) % outline.length];
      const drainage = isDrainageEdge(oi, ei);

      if (drainage) {
        ctx.strokeStyle = "hsl(210, 85%, 50%)";
        ctx.lineWidth = 4;
      } else {
        ctx.strokeStyle = "hsl(220, 15%, 30%)";
        ctx.lineWidth = 2.5;
      }

      ctx.beginPath();
      ctx.moveTo(p1.x + offset.x, p1.y + offset.y);
      ctx.lineTo(p2.x + offset.x, p2.y + offset.y);
      ctx.stroke();

      if (drainage) {
        drawDrainageArrows(ctx, { x: p1.x + offset.x, y: p1.y + offset.y }, { x: p2.x + offset.x, y: p2.y + offset.y });
      }

      ctx.fillStyle = "hsl(220, 15%, 30%)";
      ctx.beginPath();
      ctx.arc(p1.x + offset.x, p1.y + offset.y, 3, 0, 2 * Math.PI);
      ctx.fill();
    }
  }

  // Interior holes (cutouts and penetrations)
  for (const hole of interiorHoles) {
    if (hole.length < 3) continue;
    ctx.fillStyle = "hsl(0, 0%, 100%)";
    ctx.strokeStyle = "hsl(0, 0%, 40%)";
    ctx.lineWidth = 2;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(hole[0].x + offset.x, hole[0].y + offset.y);
    for (let i = 1; i < hole.length; i++) {
      ctx.lineTo(hole[i].x + offset.x, hole[i].y + offset.y);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);
  }

  const markers = outletMarkerGeometries(outlets, roofOutlines, interiorHoles, displayScale, outlineIds, 4);
  outlets.forEach((outlet, index) => {
    drawOutletMarker(ctx, outlet, markers[index], false, offset);
  });

  drawLegend(ctx, width, drainageEdges.length > 0, outlets.length > 0);
}

const EXPORT_LONG_EDGE_PX = 2400;
const MAX_EXPORT_SCALE = 4;

function createCanvas(width: number, height: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas drawing is not available in this browser.");
  return { canvas, ctx };
}

export function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob(
    blob => blob ? resolve(blob) : reject(new Error("Unable to create the PNG image.")), "image/png"));
}

const exportScale = (width: number, height: number) =>
  Math.min(MAX_EXPORT_SCALE, Math.max(1, EXPORT_LONG_EDGE_PX / Math.max(width, height, 1)));

/** The Project Details drawing without grid or hover state, upscaled for print. */
export function renderDrawingPng(data: IllustrationData): Promise<Blob> {
  const bounds = illustrationBounds(data.roofOutlines, data.outlets);
  const width = bounds.w + ILLUSTRATION_PADDING * 2, height = bounds.h + ILLUSTRATION_PADDING * 2;
  const scale = exportScale(width, height);
  const { canvas, ctx } = createCanvas(width * scale, height * scale);
  ctx.scale(scale, scale);
  drawRoofIllustration(ctx, data, { offset: { x: ILLUSTRATION_PADDING - bounds.minX, y: ILLUSTRATION_PADDING - bounds.minY },
    width, height, displayScale: 1, grid: false });
  return canvasToPng(canvas);
}

const tracePath = (ctx: CanvasRenderingContext2D, ring: Point[]) => {
  ctx.moveTo(ring[0].x, ring[0].y);
  for (let index = 1; index < ring.length; index++) ctx.lineTo(ring[index].x, ring[index].y);
  ctx.closePath();
};

/** White insulated roof area on black, in model millimetres with the margin described by maskLayout. */
export function renderMaskPng(model: RoofExportModel): Promise<Blob> {
  const layout = maskLayout(model);
  const { canvas, ctx } = createCanvas(layout.width_px, layout.height_px);
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const scale = layout.px_per_mm;
  ctx.setTransform(scale, 0, 0, -scale, -layout.top_left_mm.x * scale, layout.top_left_mm.y * scale);
  ctx.fillStyle = "#ffffff";
  for (const area of model.roof_areas.filter(area => area.outline.length >= 3)) {
    ctx.beginPath(); tracePath(ctx, area.outline); ctx.fill();
  }
  ctx.fillStyle = "#000000";
  for (const opening of model.openings.filter(opening => opening.outline.length >= 3)) {
    ctx.beginPath(); tracePath(ctx, opening.outline); ctx.fill();
  }
  return canvasToPng(canvas);
}

async function loadImage(blob: Blob): Promise<CanvasImageSource> {
  if (typeof createImageBitmap === "function") return createImageBitmap(blob);
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("Unable to load the roof plan page image."));
      image.src = url;
    });
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}

const MARKUP_RED = "#e11d2e";

/** The original page raster with this page's roof area, openings, drainage edges and outlets drawn over it. */
export async function renderMarkedUpPagePng(page: PageSession): Promise<Blob> {
  const { source_width: width, source_height: height } = page.source;
  const { canvas, ctx } = createCanvas(width, height);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(await loadImage(page.source.source_blob), 0, 0, width, height);
  const line = Math.max(2, Math.max(width, height) / 600);
  const outlines = page.drawing.outlines.map(outline => outline.points).filter(ring => ring.length >= 3);
  const holes = [...page.drawing.holes.map(hole => hole.points), ...penetrationOpenings(page).map(opening => opening.points)]
    .filter(ring => ring.length >= 3);

  ctx.lineJoin = "round";
  ctx.fillStyle = "rgba(225, 29, 46, 0.12)";
  ctx.strokeStyle = MARKUP_RED;
  ctx.lineWidth = line;
  for (const outline of outlines) {
    ctx.beginPath(); tracePath(ctx, outline); ctx.fill(); ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.lineWidth = line * 0.75;
  for (const hole of holes) {
    ctx.beginPath(); tracePath(ctx, hole); ctx.stroke();
  }
  ctx.setLineDash([]);

  ctx.strokeStyle = "#0077CC";
  ctx.lineCap = "round";
  ctx.lineWidth = line * 1.5;
  for (const edge of editorDrainage(page)) {
    const ring = page.drawing.outlines[edge.outlineIndex]?.points;
    if (!ring || ring.length < 2) continue;
    const start = ring[edge.edgeIndex % ring.length], end = ring[(edge.edgeIndex + 1) % ring.length];
    ctx.beginPath(); ctx.moveTo(start.x, start.y); ctx.lineTo(end.x, end.y); ctx.stroke();
  }

  ctx.strokeStyle = OUTLET_COLOUR;
  ctx.lineWidth = line;
  const radius = Math.max(8, Math.max(width, height) / 160);
  for (const outlet of activePageOutlets(page)) {
    ctx.beginPath(); ctx.arc(outlet.x, outlet.y, radius, 0, Math.PI * 2); ctx.stroke();
  }
  return canvasToPng(canvas);
}
