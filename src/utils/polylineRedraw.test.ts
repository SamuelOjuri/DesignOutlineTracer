import { describe, expect, it } from "vitest";
import type { Point } from "@/types/roof";
import type { VectorSegment } from "@/types/outline";
import { findOutlineAnchor, matchRedrawEndpoint, preparePolylineRedraw, REDRAW_VERTEX_MATCH_TOLERANCE, redrawRegionIntrusions,
  redrawSection, snapToVectors, type OutlineAnchor, type RedrawRegion, type VectorSnap } from "./polylineRedraw";

const roof = [{ x: 40, y: 40 }, { x: 200, y: 40 }, { x: 200, y: 260 }, { x: 40, y: 260 }];
const bounds = { width: 2000, height: 2000 };
const box = (left: number, top: number, right: number, bottom: number): Point[] => [
  { x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom },
];
const anchor = (polygon: Point[], point: Point): OutlineAnchor => {
  const result = findOutlineAnchor(point, [polygon], 1e-5);
  expect(result).not.toBeNull();
  return result!;
};
const coordinates = (points: Point[]) => points.map(({ x, y }) => [x, y]);

describe("polyline outline anchors and paths", () => {
  it("projects onto finite sides without rounding and canonicalizes closing corners", () => {
    const outline = box(10.25, 20.5, 110.25, 120.5);
    expect(findOutlineAnchor({ x: 30.125, y: 22 }, [outline], 2)).toEqual({
      outlineIndex: 0, edgeIndex: 0, t: .19875, point: { x: 30.125, y: 20.5 },
    });
    expect(anchor(outline, outline[0])).toEqual({ outlineIndex: 0, edgeIndex: 0, t: 0, point: outline[0] });
    expect(findOutlineAnchor({ x: 130, y: 20 }, [outline], 2)).toBeNull();
    expect(findOutlineAnchor({ x: NaN, y: 20 }, [outline], 2)).toBeNull();
  });

  it("chooses the shorter arc for partial anchors, with a reversible explicit path", () => {
    const start = anchor(roof, { x: 80, y: 40 }), end = anchor(roof, { x: 160, y: 40 });
    expect(coordinates(redrawSection([roof], start, end))).toEqual([[80, 40], [160, 40]]);
    expect(coordinates(redrawSection([roof], start, end, true))).toEqual([
      [80, 40], [40, 40], [40, 260], [200, 260], [200, 40], [160, 40],
    ]);
    expect(redrawSection([roof], start, start)).toEqual([]);
  });

  it("snaps near existing corners unless precise partial-edge placement is requested", () => {
    const outline = box(10.25, 20.5, 110.25, 120.5);
    const point = { x: 11.25, y: 20.75 };
    expect(findOutlineAnchor(point, [outline], 2)).toEqual({
      outlineIndex: 0, edgeIndex: 0, t: 0, point: outline[0],
    });
    expect(findOutlineAnchor(point, [outline], 2, false)).toEqual({
      outlineIndex: 0, edgeIndex: 0, t: .01, point: { x: 11.25, y: 20.5 },
    });
    expect(findOutlineAnchor({ x: 10.5, y: 21.5 }, [outline], 2)).toMatchObject({ edgeIndex: 0, t: 0 });
  });

  it("selects closing-edge and reversed-ring sections in the user's click order", () => {
    for (const polygon of [roof, [...roof].reverse()]) {
      const start = anchor(polygon, { x: 40, y: 210 }), end = anchor(polygon, { x: 40, y: 100 });
      expect(coordinates(redrawSection([polygon], start, end))).toEqual([[40, 210], [40, 100]]);
    }
  });
});

describe("PDF vector snapping", () => {
  const line = (x1: number, y1: number, x2: number, y2: number): VectorSegment =>
    ({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 } });

  it("prefers a nearby real endpoint over a closer point along its line", () => {
    const stroke = line(10.25, 20.5, 110.25, 20.5);
    expect(snapToVectors({ x: 12, y: 20.75 }, [stroke], 3)).toEqual({
      point: stroke.start, kind: "endpoint", segments: [stroke],
    });
  });

  it("snaps to finite intersections and highlights both contributing strokes", () => {
    const a = line(10, 50, 90, 50), b = line(50, 10, 50, 90);
    expect(snapToVectors({ x: 51, y: 51 }, [a, b], 3)).toEqual({
      point: { x: 50, y: 50 }, kind: "intersection", segments: [a, b],
    });
    const beyond = line(100, 10, 100, 90);
    expect(snapToVectors({ x: 100, y: 50 }, [a, beyond], 3)).toMatchObject({ kind: "line" });
  });

  it("projects to a rotated line and ignores distant or invalid evidence", () => {
    const diagonal = line(10.5, 10.5, 110.5, 110.5);
    const snap = snapToVectors({ x: 50.25, y: 51.75 }, [diagonal, line(NaN, 1, 3, 4)], 3);
    expect(snap).toEqual({ point: { x: 51, y: 51 }, kind: "line", segments: [diagonal] });
    expect(snapToVectors({ x: 150, y: 150 }, [diagonal], 3)).toBeNull();
    expect(snapToVectors({ x: 50, y: 50 }, [line(50, 50, 50, 50)], 3)).toBeNull();
  });

  it("deduplicates dense repeated PDF strokes before finding the crossing line", () => {
    const horizontal = line(10, 50, 90, 50), vertical = line(50, 10, 50, 90);
    const repeated = Array.from({ length: 2500 }, (_, index) => index % 2
      ? { start: horizontal.end, end: horizontal.start } : horizontal);
    const snap = snapToVectors({ x: 51, y: 51 }, [...repeated, vertical], 3);
    expect(snap).toEqual({ point: { x: 50, y: 50 }, kind: "intersection", segments: [horizontal, vertical] });
  });
});

describe("PDF endpoint completion", () => {
  const endpoint = (point: Point): VectorSnap => ({ point, kind: "endpoint", segments: [] });

  it("matches fractional rotated PDF corners within numeric noise and returns the actual vertex", () => {
    const angle = 20 * Math.PI / 180;
    const polygon = roof.map(({ x, y }) => ({ x: 510.125 + x * Math.cos(angle) - y * Math.sin(angle),
      y: 310.375 + x * Math.sin(angle) + y * Math.cos(angle) }));
    const start = anchor(polygon, polygon[0]);
    const corner = polygon[2];
    const snap = endpoint({ x: corner.x + REDRAW_VERTEX_MATCH_TOLERANCE / 4,
      y: corner.y - REDRAW_VERTEX_MATCH_TOLERANCE / 4 });
    const result = matchRedrawEndpoint(snap, [polygon], start);
    expect(result).toEqual({ outlineIndex: 0, edgeIndex: 2, t: 0, point: corner });
    expect(result?.point).toBe(corner);
  });

  it("does not project an endpoint onto an edge or bridge a two-pixel return", () => {
    const polygon = [roof[0], roof[1], { x: 200, y: 160 }, { x: 198, y: 160 }, { x: 198, y: 260 }, roof[3]];
    const start = anchor(polygon, polygon[0]);
    expect(matchRedrawEndpoint(endpoint({ x: 200, y: 162 }), [polygon], start)).toBeNull();
    expect(matchRedrawEndpoint(endpoint({ x: 199, y: 160 }), [polygon], start)).toBeNull();
    expect(matchRedrawEndpoint(endpoint({ x: 199.999, y: 160 }), [polygon], start)).toBeNull();
    expect(matchRedrawEndpoint(endpoint(polygon[3]), [polygon], start)).toMatchObject({ edgeIndex: 3, t: 0 });
  });

  it("requires an endpoint snap on the starting outline and excludes the starting coordinate", () => {
    const other = box(300, 40, 400, 260), start = anchor(roof, roof[0]);
    const outlines = [roof, other];
    expect(matchRedrawEndpoint(null, outlines, start)).toBeNull();
    for (const kind of ["line", "intersection"] as const) {
      expect(matchRedrawEndpoint({ point: roof[2], kind, segments: [] }, outlines, start)).toBeNull();
    }
    expect(matchRedrawEndpoint(endpoint(other[2]), outlines, start)).toBeNull();
    expect(matchRedrawEndpoint(endpoint(roof[0]), outlines, start)).toBeNull();
    expect(matchRedrawEndpoint(endpoint({ x: roof[0].x + 1e-5, y: roof[0].y }), outlines, start)).toBeNull();
    expect(matchRedrawEndpoint(endpoint({ x: NaN, y: 260 }), outlines, start)).toBeNull();
    expect(matchRedrawEndpoint(endpoint(roof[2]), outlines, { ...start, outlineIndex: 10 })).toBeNull();
  });

  it("rejects ambiguous actual vertices even if one is closer", () => {
    const polygon = [roof[0], roof[1], roof[2], { x: 200 - REDRAW_VERTEX_MATCH_TOLERANCE / 2, y: 260 }, roof[3]];
    expect(matchRedrawEndpoint(endpoint(roof[2]), [polygon], anchor(polygon, polygon[0]))).toBeNull();
    const duplicate = [...roof, roof[2]];
    expect(matchRedrawEndpoint(endpoint(roof[2]), [duplicate], anchor(duplicate, duplicate[0]))).toBeNull();
  });
});

describe("local polyline replacement", () => {
  it.each([0, 31, 147])("adds the missed inward jog at %s degrees, for either winding", degrees => {
    const angle = degrees * Math.PI / 180;
    const transform = (p: Point): Point => ({ x: 600 + p.x * Math.cos(angle) - p.y * Math.sin(angle),
      y: 600 + p.x * Math.sin(angle) + p.y * Math.cos(angle) });
    const startPoint = { x: 200, y: 120 }, endPoint = { x: 170, y: 260 };
    const via = [{ x: 200, y: 190 }, { x: 190, y: 190 }, { x: 190, y: 260 }];
    const expected = [roof[0], roof[1], startPoint, ...via, endPoint, roof[3]].map(transform);
    for (const reverse of [false, true]) {
      const polygon = (reverse ? [...roof].reverse() : roof).map(transform);
      const other = box(1100, 1100, 1200, 1200), hole = box(70, 80, 90, 100).map(transform);
      const before = JSON.stringify([polygon, other, hole]);
      const edit = preparePolylineRedraw([polygon, other], [hole], [], anchor(polygon, transform(startPoint)),
        anchor(polygon, transform(endPoint)), via.map(transform), false, bounds);
      expect(edit.error).toBeNull();
      expect(edit.outlines[0]).toHaveLength(expected.length);
      for (const point of expected) {
        expect(edit.outlines[0].some(actual => Math.hypot(point.x - actual.x, point.y - actual.y) < 1e-7)).toBe(true);
      }
      expect(edit.outlines[1]).toBe(other);
      expect(edit.holes).toEqual([hole]);
      expect(edit.editedOutlineIndex).toBe(0);
      expect(JSON.stringify([polygon, other, hole])).toBe(before);
    }
  });

  it("redraws part of the closing edge and preserves ring start and retained drainage portions", () => {
    const start = anchor(roof, { x: 40, y: 210 }), end = anchor(roof, { x: 40, y: 100 });
    const edit = preparePolylineRedraw([roof], [], [], start, end, [{ x: 30.25, y: 210 }, { x: 30.25, y: 100 }], false, bounds);
    expect(edit.error).toBeNull();
    expect(coordinates(edit.outlines[0])).toEqual([
      [40, 40], [200, 40], [200, 260], [40, 260], [40, 210], [30.25, 210], [30.25, 100], [40, 100],
    ]);
    expect(edit.outlines[0][0]).toBe(roof[0]);
    expect(edit.edgeRemap).toEqual([[0], [1], [2], [7, 3]]);
  });

  it("maps only retained edges when a replacement keeps the same vertex count", () => {
    const polygon = [...roof.slice(0, 2), { x: 200, y: 160 }, ...roof.slice(2)];
    const edit = preparePolylineRedraw([polygon], [], [], anchor(polygon, polygon[1]), anchor(polygon, polygon[3]),
      [{ x: 190, y: 160 }], false, bounds);
    expect(edit.error).toBeNull();
    expect(edit.outlines[0]).toHaveLength(polygon.length);
    expect(edit.edgeRemap).toEqual([[0], [], [], [3], [4]]);
  });

  it("maps reversed-path partial edges without assigning drainage to the new path", () => {
    const start = anchor(roof, { x: 160, y: 40 }), end = anchor(roof, { x: 80, y: 40 });
    const edit = preparePolylineRedraw([roof], [], [], start, end, [{ x: 160, y: 30 }, { x: 80, y: 30 }], false, bounds);
    expect(edit.error).toBeNull();
    expect(coordinates(edit.outlines[0])).toEqual([
      [40, 40], [80, 40], [80, 30], [160, 30], [160, 40], [200, 40], [200, 260], [40, 260],
    ]);
    expect(edit.edgeRemap).toEqual([[4, 0], [5], [6], [7]]);
  });

  it("uses Other path explicitly while retaining the untouched partial edge", () => {
    const start = anchor(roof, { x: 80, y: 40 }), end = anchor(roof, { x: 160, y: 40 });
    const edit = preparePolylineRedraw([roof], [], [], start, end, [{ x: 80, y: 80 }, { x: 160, y: 80 }], true, bounds);
    expect(edit.error).toBeNull();
    expect(edit.outlines[0]).toHaveLength(4);
    expect(edit.edgeRemap).toEqual([[3], [], [], []]);
  });

  it("blocks repeated points, retraces, crossing paths, invalid anchors and off-page edits", () => {
    const start = anchor(roof, roof[1]), end = anchor(roof, roof[2]);
    const attempt = (via: Point[]) => preparePolylineRedraw([roof], [], [], start, end, via, false, bounds);
    expect(attempt([{ x: 180, y: 100 }, { x: 180, y: 100 }]).error).toMatch(/same position|repeated/);
    expect(attempt([{ x: 200, y: 150 }, { x: 200, y: 100 }]).error).toMatch(/retrace/);
    expect(attempt([{ x: 20, y: 120 }, { x: 220, y: 120 }]).error).toMatch(/cross|touch/);
    expect(attempt([{ x: -10, y: 150 }]).error).toMatch(/drawing page/);
    expect(attempt([{ x: NaN, y: 150 }]).error).toMatch(/invalid coordinates/);
    expect(preparePolylineRedraw([roof], [], [], start, start, [], false, bounds).error).toMatch(/different positions/);
    expect(preparePolylineRedraw([roof], [], [], { ...start, t: .4 }, end, [], false, bounds).error).toMatch(/same roof boundary/);
    expect(preparePolylineRedraw([roof, roof], [], [], start, { ...end, outlineIndex: 1 }, [], false, bounds).error).toMatch(/same roof boundary/);
  });

  it("blocks other-roof collisions and changes to cutouts or reviewed openings", () => {
    const start = anchor(roof, roof[1]), end = anchor(roof, roof[2]);
    const via = [{ x: 220, y: 40 }, { x: 220, y: 260 }];
    const other = box(210, 90, 240, 120);
    expect(preparePolylineRedraw([roof, other], [], [], start, end, via, false, bounds).error).toMatch(/touch or overlap/);
    const opening = box(170, 120, 190, 160);
    for (const reviewed of [false, true]) {
      const holes = reviewed ? [] : [opening], openings = reviewed ? [opening] : [];
      const edit = preparePolylineRedraw([roof], holes, openings, start, end,
        [{ x: 160, y: 80 }, { x: 160, y: 220 }], false, bounds);
      expect(edit.error).toMatch(/cutout, opening/);
      expect(edit.holes).toBe(holes);
    }
  });
});

describe("redraw intrusions into roof areas that still need an outline", () => {
  // roof spans x 40..200, y 40..260.
  const region = (id: string, left: number, top: number, right: number, bottom: number): RedrawRegion =>
    ({ id, label: `Roof area ${id}`, left, top, right, bottom });
  const outward = [roof[0], roof[1], { x: 200, y: 100 }, { x: 260, y: 100 }, { x: 260, y: 200 }, { x: 200, y: 200 }, roof[2], roof[3]];

  it("flags only regions that gain roof area beyond the original outline", () => {
    const east = region("2", 230, 0, 400, 400), far = region("3", 500, 0, 600, 400);
    expect(redrawRegionIntrusions(roof, outward, [east, far])).toEqual([east]);
    // Area added by the redraw is reported even when the region box also overlaps the original roof.
    const overlapping = region("4", 150, 0, 400, 400);
    expect(redrawRegionIntrusions(roof, outward, [overlapping])).toEqual([overlapping]);
  });

  it("ignores pre-existing overlap, inward redraws, edge contact and sub-pixel slivers", () => {
    const overlapping = region("2", 150, 0, 400, 400);
    const inward = [roof[0], roof[1], { x: 200, y: 100 }, { x: 160, y: 100 }, { x: 160, y: 200 }, { x: 200, y: 200 }, roof[2], roof[3]];
    expect(redrawRegionIntrusions(roof, inward, [overlapping])).toEqual([]);
    // The added area spans y 100..200, entirely above a region box starting at y = 210.
    const south = region("3", 0, 210, 400, 400);
    expect(redrawRegionIntrusions(roof, outward, [south])).toEqual([]);
    const touching = region("4", 260, 0, 400, 400);
    expect(redrawRegionIntrusions(roof, outward, [touching])).toEqual([]);
    const sliver = [roof[0], roof[1], { x: 200, y: 100 }, { x: 200.001, y: 100 }, { x: 200.001, y: 200 }, { x: 200, y: 200 }, roof[2], roof[3]];
    expect(redrawRegionIntrusions(roof, sliver, [overlapping])).toEqual([]);
    expect(redrawRegionIntrusions(roof, outward, [])).toEqual([]);
  });
});
