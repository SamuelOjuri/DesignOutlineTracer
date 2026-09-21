import { describe, expect, it } from "vitest";
import { findClosestEdge, findVertexMergeTarget, isValidOutlineEdit, mergePolygonVertex, movePolygonEdge, prepareEdgeEdit, prepareOutlineEdit, rasterizeOutlinesWithHoles, straightenPolygonSide } from "./polygonAdjust";
import type { Point } from "@/types/roof";
import { steppedRoof, trimmedRoof, trimmedRoofWithNotch } from "@/test/roofBoundary";
import polygonClipping, { type Polygon } from "polygon-clipping";

const rectangle: Point[] = [{ x: 10, y: 10 }, { x: 100, y: 10 }, { x: 100, y: 100 }, { x: 10, y: 100 }];
const extraPoint = [...rectangle.slice(0, 2), { x: 102, y: 50 }, ...rectangle.slice(2)];

describe("inward edge trimming", () => {
  const polygon = (points: Point[]): Polygon => [points.map(point => [point.x, point.y])];
  const mask = (outlines: Point[][], holes: Point[][] = []) => rasterizeOutlinesWithHoles(outlines, holes, 400, 300);
  const drag = (outlines: Point[][], x: number, y: number, dx: number, dy: number, holes: Point[][] = []) => {
    const edge = findClosestEdge(x, y, outlines, 1)!;
    return prepareEdgeEdit(outlines, edge.outlineIndex, edge.edgeIndex, dx, dy, holes);
  };

  it.each([false, true])("trims the top and right in either order, reversed winding: %s", reversed => {
    const original = reversed ? [...steppedRoof].reverse() : steppedRoof;
    for (const topFirst of [false, true]) {
      const first = topFirst ? drag([original], 240, 40, 0, 60) : drag([original], 300, 70, -16, 0);
      expect(first.error).toBeNull();
      expect(first.outlines).toHaveLength(topFirst ? 2 : 1);
      const second = topFirst ? drag(first.outlines, 300, 125, -16, 0) : drag(first.outlines, 240, 40, 0, 60);
      expect(second.error).toBeNull();
      expect(second.outlines).toHaveLength(1);
      expect(mask(second.outlines)).toEqual(mask([trimmedRoof]));
      expect(prepareOutlineEdit(second.outlines, 0, second.outlines[0], []).error).toBeNull();
    }
  });

  it.each([
    [0, 0, 20], // Top exactly meets the left step.
    [0, 0, 60], // Top exactly meets the right return.
    [0, 0, 75], // Top passes the return.
    [1, -8, 0], // Right exactly meets the narrow return.
    [1, -16, 0], // Right exactly meets the intended boundary.
    [1, -24, 0], // Right passes both return edges.
  ])("rebuilds a valid boundary at edge %s, delta (%s, %s)", (edgeIndex, dx, dy) => {
    expect(prepareOutlineEdit([steppedRoof], 0, movePolygonEdge(steppedRoof, edgeIndex, dx, dy), []).error).not.toBeNull();
    const edit = prepareEdgeEdit([steppedRoof], 0, edgeIndex, dx, dy, []);
    expect(edit.error).toBeNull();
    for (const [index, outline] of edit.outlines.entries()) {
      expect(prepareOutlineEdit(edit.outlines, index, outline, edit.holes).error).toBeNull();
    }
    expect(polygonClipping.difference(edit.outlines.map(polygon), polygon(steppedRoof))).toEqual([]);
  });

  it("only removes area as a drag continues through the return", () => {
    for (const edgeIndex of [0, 1]) {
      let previous = [polygon(steppedRoof)];
      for (const distance of [1, 8, 16, 20, 40, 60, 75, 110]) {
        const edit = prepareEdgeEdit([steppedRoof], 0, edgeIndex, edgeIndex ? -distance : 0, edgeIndex ? 0 : distance, []);
        expect(edit.error).toBeNull();
        const next = edit.outlines.map(polygon);
        expect(polygonClipping.difference(next, previous)).toEqual([]);
        previous = next;
      }
    }
  });

  it("preserves vertex order for an ordinary inward move across the closing edge", () => {
    const rotated = [...extraPoint.slice(1), extraPoint[0]];
    const result = prepareEdgeEdit([rotated], 0, rotated.length - 1, 0, 10, []);
    expect(result.error).toBeNull();
    expect(result.editedOutlineIndex).toBe(0);
    expect(result.outlines[0]).toEqual([
      { x: 100, y: 20 }, { x: 102, y: 50 }, { x: 100, y: 100 }, { x: 10, y: 100 }, { x: 10, y: 20 },
    ]);
  });

  it("handles sloping neighbours and diagonal edges without leaving spikes or adding area", () => {
    const cases = [
      { outline: extraPoint, edge: 0, dx: 0, dy: 45 },
      { outline: [{ x: 50, y: 10 }, { x: 100, y: 60 }, { x: 50, y: 110 }, { x: 0, y: 60 }], edge: 0, dx: -10, dy: 10 },
    ];
    for (const { outline, edge, dx, dy } of cases) {
      const edit = prepareEdgeEdit([outline], 0, edge, dx, dy, []);
      expect(edit.error).toBeNull();
      expect(polygonClipping.difference(edit.outlines.map(polygon), polygon(outline))).toEqual([]);
      expect(prepareOutlineEdit(edit.outlines, 0, edit.outlines[0], []).error).toBeNull();
    }
    const lowered = prepareEdgeEdit([extraPoint], 0, 0, 0, 45, []);
    expect(Math.min(...lowered.outlines[0].map(point => point.y))).toBe(55);
  });

  it("preserves other roofs and inside holes, removes excluded holes and opens partial holes into notches", () => {
    const box = (left: number, top: number, right: number, bottom: number): Point[] => [
      { x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom },
    ];
    const neighbour = box(330, 40, 380, 270);
    const inside = box(200, 150, 220, 170), outside = box(200, 65, 220, 80);
    const partial = box(220, 90, 240, 115), unrelated = box(345, 60, 360, 85);
    const holes = [inside, outside, partial, unrelated];
    const top = drag([steppedRoof, neighbour], 240, 40, 0, 60, holes);
    expect(top.error).toBeNull();
    expect(top.holes).toEqual([inside, unrelated]);
    expect(top.holes[0]).toBe(inside);
    expect(top.holes[1]).toBe(unrelated);
    expect(top.outlines[top.outlines.length - 1]).toBe(neighbour);
    expect(top.outlines[0]).toContainEqual({ x: 220, y: 100 });
    expect(top.outlines[0]).toContainEqual({ x: 240, y: 115 });
    const right = drag(top.outlines, 300, 125, -16, 0, top.holes);
    expect(right.error).toBeNull();
    expect(right.outlines[right.outlines.length - 1]).toBe(neighbour);
    expect(mask(right.outlines, right.holes)).toEqual(mask([trimmedRoofWithNotch, neighbour], [inside, unrelated]));
  });

  it("can remove a separate area but rejects emptying the last area, invalid coordinates and unsafe outward moves", () => {
    const neighbour = rectangle.map(point => ({ ...point, x: point.x + 100 }));
    const removed = prepareEdgeEdit([rectangle, neighbour], 0, 0, 0, 100, []);
    expect(removed.error).toBeNull();
    expect(removed.outlines).toEqual([neighbour]);
    expect(removed.outlines[0]).toBe(neighbour);
    const empty = prepareEdgeEdit([rectangle], 0, 0, 0, 100, []);
    expect(empty.error).toContain("no insulation area");
    expect(empty.outlines).toEqual([rectangle]);
    expect(prepareEdgeEdit([rectangle], 0, 0, NaN, 1, []).error).toContain("invalid coordinates");
    expect(prepareEdgeEdit([rectangle, neighbour], 0, 1, 10, 0, []).error).toContain("roof area 2");
    const recessed: Point[] = [
      { x: 10, y: 10 }, { x: 100, y: 10 }, { x: 100, y: 30 }, { x: 30, y: 30 },
      { x: 30, y: 80 }, { x: 100, y: 80 }, { x: 100, y: 100 }, { x: 10, y: 100 },
    ];
    expect(prepareEdgeEdit([recessed], 0, 2, 0, 60, []).error).toContain("cross, touch or retrace");
  });
});

describe("vertex merging", () => {
  it("removes the dragged point, preserves the target and supports the closing edge", () => {
    expect(findVertexMergeTarget(extraPoint, 2, { x: 99, y: 12 }, 8)).toBe(1);
    expect(mergePolygonVertex(extraPoint, 2, 1)).toEqual(rectangle);
    expect(isValidOutlineEdit([extraPoint], 0, rectangle, [])).toBe(true);
    expect(mergePolygonVertex(rectangle, 0, 3)).toEqual(rectangle.slice(1));
    expect(extraPoint).toHaveLength(5);
  });

  it("ignores distant and non-neighbouring points and never collapses a triangle", () => {
    expect(findVertexMergeTarget(extraPoint, 2, rectangle[0], 8)).toBeNull();
    expect(findVertexMergeTarget(extraPoint, 2, { x: 102, y: 50 }, 8)).toBeNull();
    expect(mergePolygonVertex(extraPoint, 0, 2)).toBeNull();
    expect(findVertexMergeTarget(rectangle.slice(0, 3), 0, rectangle[1], 8)).toBeNull();
    expect(mergePolygonVertex(rectangle.slice(0, 3), 0, 1)).toBeNull();
  });
});

describe("side straightening", () => {
  it("aligns a complete side without merging intermediate points or changing other sides", () => {
    const result = straightenPolygonSide(extraPoint, 1)!;
    expect(result).toHaveLength(5);
    expect(result).toEqual([...rectangle.slice(0, 2), { x: 100, y: 50 }, ...rectangle.slice(2)]);
    expect(isValidOutlineEdit([extraPoint], 0, result, [])).toBe(true);
    expect(straightenPolygonSide(extraPoint, 2)).toEqual(result);
  });

  it("handles wraparound, horizontal sides and reversed winding", () => {
    const top = [{ x: 10, y: 11 }, { x: 50, y: 9 }, { x: 100, y: 11 }, ...rectangle.slice(2)];
    expect(straightenPolygonSide(top, 0)!.slice(0, 3).map(point => point.y)).toEqual([11, 11, 11]);
    const rotated = [...extraPoint.slice(2), ...extraPoint.slice(0, 2)];
    expect(straightenPolygonSide(rotated, 4)!.map(point => point.x)).toEqual([100, 100, 10, 10, 100]);
    expect(straightenPolygonSide([...extraPoint].reverse(), 1)!.map(point => point.x)).toEqual([10, 100, 100, 100, 10]);
    expect(straightenPolygonSide([{ x: 0, y: 0 }, { x: 50, y: 50 }, { x: 0, y: 100 }], 0)).toBeNull();
  });
});

describe("adjustment safety", () => {
  it("rejects duplicates, collapsed polygons, reversed winding and crossed edges", () => {
    expect(isValidOutlineEdit([rectangle], 0, [rectangle[0], rectangle[1], rectangle[1], rectangle[3]], [])).toBe(false);
    expect(isValidOutlineEdit([rectangle], 0, [{ x: 10, y: 10 }, { x: 20, y: 10 }, { x: 30, y: 10 }], [])).toBe(false);
    expect(isValidOutlineEdit([rectangle], 0, [...rectangle].reverse(), [])).toBe(false);
    expect(isValidOutlineEdit([rectangle], 0, [rectangle[0], rectangle[2], rectangle[1], rectangle[3]], [])).toBe(false);
  });

  it("allows scope reduction past cutouts but prevents touching or overlapping separate roofs", () => {
    const hole = rectangle.map(point => ({ x: point.x / 4 + 65, y: point.y / 4 + 10 }));
    expect(isValidOutlineEdit([rectangle], 0, rectangle, [hole])).toBe(true);
    expect(isValidOutlineEdit([rectangle], 0, rectangle.filter((_, index) => index !== 1), [hole])).toBe(true);
    const neighbour = rectangle.map(point => ({ ...point, x: point.x + 100 }));
    expect(isValidOutlineEdit([rectangle, neighbour], 0, rectangle, [])).toBe(true);
    const touching = rectangle.map(point => ({ ...point, x: point.x === 100 ? 110 : point.x }));
    expect(isValidOutlineEdit([rectangle, neighbour], 0, touching, [])).toBe(false);
  });

  it("does not block an unrelated edit because of an existing retraced boundary", () => {
    const retraced = [rectangle[0], rectangle[1], { x: 100, y: 60 }, { x: 100, y: 40 },
      { x: 90, y: 40 }, { x: 90, y: 100 }, rectangle[3]];
    const reduced = retraced.map(point => point.x === 10 ? { ...point, x: 20 } : point);
    expect(isValidOutlineEdit([retraced], 0, reduced, [])).toBe(true);
    const worse = reduced.map((point, index) => index === 2 ? { ...point, y: 80 } : point);
    expect(isValidOutlineEdit([retraced], 0, worse, [])).toBe(false);
    const repaired = prepareOutlineEdit([retraced], 0, reduced, []);
    expect(repaired.repaired).toBe(true);
    expect(repaired.outlines[0]).not.toContainEqual({ x: 100, y: 60 });
    expect(isValidOutlineEdit(repaired.outlines, 0, repaired.outlines[0], [])).toBe(true);
    const loweredTop = retraced.map((point, index) => index < 2 ? { ...point, y: 20 } : point);
    expect(prepareOutlineEdit([retraced], 0, loweredTop, []).error).toBeNull();
    const shortenedReturn = retraced.map((point, index) => index === 2 ? { ...point, y: 50 } : point);
    expect(prepareOutlineEdit([retraced], 0, shortenedReturn, []).error).toBeNull();
    const crossedTop = retraced.map((point, index) => index < 2 ? { ...point, y: 50 } : point);
    expect(prepareOutlineEdit([retraced], 0, crossedTop, []).error).toContain("creates or worsens");
  });
});

describe("scope and cutout reconciliation", () => {
  const box = (left: number, top: number, right: number, bottom: number): Point[] => [
    { x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom },
  ];
  const scope = box(10, 50, 100, 100);
  const outside = box(30, 20, 50, 40);
  const inside = box(60, 70, 80, 90);
  const partial = box(30, 40, 50, 65);
  const neighbour = box(110, 10, 150, 100);
  const neighbourHole = box(120, 30, 140, 50);

  it("removes excluded cutouts and preserves inside and unrelated cutouts exactly", () => {
    const result = prepareOutlineEdit([rectangle, neighbour], 0, scope, [outside, inside, neighbourHole]);
    expect(result.error).toBeNull();
    expect(result.outlines).toEqual([scope, neighbour]);
    expect(result.holes).toEqual([inside, neighbourHole]);
    expect(result.holes[0]).toBe(inside);
    expect(result.editedOutlineIndex).toBe(0);
  });

  it("turns a partially excluded cutout into a notch while preserving other holes and roofs", () => {
    const result = prepareOutlineEdit([rectangle, neighbour], 0, scope, [partial, inside, neighbourHole]);
    expect(result.error).toBeNull();
    expect(result.holes).toEqual([inside, neighbourHole]);
    expect(result.outlines[1]).toBe(neighbour);
    expect(result.outlines[0]).toContainEqual({ x: 30, y: 50 });
    expect(result.outlines[0]).toContainEqual({ x: 50, y: 65 });
    expect(result.outlines[0]).toHaveLength(8);
    expect(result.outlines[0]).toEqual(expect.arrayContaining([
      { x: 10, y: 50 }, { x: 30, y: 50 }, { x: 30, y: 65 }, { x: 50, y: 65 },
      { x: 50, y: 50 }, { x: 100, y: 50 }, { x: 100, y: 100 }, { x: 10, y: 100 },
    ]));
    const mask = rasterizeOutlinesWithHoles(result.outlines, result.holes, 160, 110);
    expect(mask[55 * 160 + 40]).toBe(0);
    expect(mask[55 * 160 + 60]).toBe(1);
    expect(mask[75 * 160 + 40]).toBe(1);
    expect(mask[80 * 160 + 70]).toBe(0);
    expect(mask[40 * 160 + 130]).toBe(0);
    expect(prepareOutlineEdit(result.outlines, 0, result.outlines[0], result.holes).error).toBeNull();
  });

  it("supports a cutout splitting the remaining scope and rejects an empty result", () => {
    const divider = box(40, 20, 60, 90);
    const reduced = box(10, 50, 100, 80);
    const result = prepareOutlineEdit([rectangle], 0, reduced, [divider]);
    expect(result.error).toBeNull();
    expect(result.outlines).toHaveLength(2);
    expect(result.holes).toEqual([]);
    expect(result.editedOutlineIndex).toBeUndefined();
    expect(prepareOutlineEdit([rectangle], 0, box(45, 55, 55, 75), [divider]).error).toContain("no insulation area");
  });

  it("keeps exact geometry when no cutout reconciliation is needed and returns specific rejection reasons", () => {
    expect(prepareOutlineEdit([extraPoint], 0, extraPoint, [inside]).outlines[0]).toBe(extraPoint);
    expect(prepareOutlineEdit([rectangle, neighbour], 0, box(10, 10, 120, 100), []).error).toContain("roof area 2");
    expect(prepareOutlineEdit([rectangle], 0, [rectangle[0], rectangle[1], rectangle[1], rectangle[3]], []).error).toContain("same position");
    expect(prepareOutlineEdit([rectangle], 0, [rectangle[0], rectangle[1]], []).error).toContain("three distinct vertices");
  });
});
