import { describe, expect, it } from "vitest";
import type { Point } from "@/types/roof";
import { penetrationSession } from "@/test/penetrations";
import { sameDrawingScope, withoutCollinearVertices } from "./scopeGeometry";

describe("scope geometry comparisons", () => {
  it("ignores exact interpolated samples on oblique and closing edges without rewriting the stored ring", () => {
    const ring: Point[] = [{ x: 20.25, y: 30.75 }, { x: 120.75, y: 60.25 },
      { x: 160.5, y: 140.75 }, { x: 10.5, y: 110.25 }];
    const midpoint = (a: Point, b: Point) => ({ x: a.x + (b.x - a.x) * 0.37, y: a.y + (b.y - a.y) * 0.37 });
    const sampled = [ring[0], midpoint(ring[0], ring[1]), ring[1], ring[2], ring[3], midpoint(ring[3], ring[0])];
    const snapshot = structuredClone(sampled);
    expect(withoutCollinearVertices(sampled)).toEqual(ring);
    expect(sampled).toEqual(snapshot);
  });

  it("retains tiny genuine bends, narrow returns, duplicate vertices and invalid coordinates", () => {
    const samples: Point[][] = [
      [{ x: 0, y: 0 }, { x: 10, y: 1e-7 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 }],
      [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 0.001 }, { x: 10.001, y: 0.001 },
        { x: 10.001, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 }],
      [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 }],
      [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 }],
      [{ x: 0, y: 0 }, { x: NaN, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 }],
    ];
    for (const ring of samples) expect(withoutCollinearVertices(ring)).toEqual(ring);
  });

  it("keeps outline and hole identity, ownership, component order and winding significant", () => {
    const drawing = penetrationSession().pages["page-1"].drawing;
    const [first, ...rest] = drawing.outlines[0].points;
    const split = { ...drawing, outlines: [{ ...drawing.outlines[0], points: [first,
      { x: (first.x + rest[0].x) / 2, y: (first.y + rest[0].y) / 2 }, ...rest] }] };
    expect(sameDrawingScope(drawing, split)).toBe(true);
    for (const field of ["id", "roi_id", "annotation_id", "outline_id"] as const) {
      expect(sameDrawingScope(drawing, { ...split,
        outlines: [{ ...split.outlines[0], [field]: "changed" }] })).toBe(false);
      expect(sameDrawingScope(drawing, { ...split,
        holes: [{ ...split.holes[0], [field]: "changed" }] })).toBe(false);
    }
    expect(sameDrawingScope(drawing, { ...drawing,
      outlines: [{ ...drawing.outlines[0], points: [...drawing.outlines[0].points].reverse() }] })).toBe(false);
  });
});
