import { describe, expect, it } from "vitest";
import { drawOutletMarker, outletMarkerGeometry } from "./outletMarker";
import { mockCanvasContext } from "@/test/canvas";

const rectangle = (left: number, top: number, right: number, bottom: number) => [
  { x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom },
];
const roof = rectangle(0, 0, 400, 400);

describe("outlet marker footprint", () => {
  it("keeps the whole glyph at 24 CSS pixels and its source anchor unchanged across zoom", () => {
    const point = Object.freeze({ x: 200, y: 200 });
    for (const scale of [0.2, 1, 3]) {
      const marker = outletMarkerGeometry(point, [roof], [], scale);
      expect(marker.outerRadius * scale).toBeCloseTo(12);
      expect((marker.circleRadius + marker.haloWidth / 2) * scale).toBeCloseTo(12);
      expect(marker.hitRadius * scale).toBe(16);
    }
    expect(point).toEqual({ x: 200, y: 200 });
  });

  it("reduces the entire painted footprint near both sides of a corner", () => {
    const marker = outletMarkerGeometry({ x: 8, y: 6 }, [roof], [], 1);
    expect(marker.status).toBe("interior");
    expect(marker.clearance).toBe(6);
    expect(marker.outerRadius).toBeCloseTo(3.5);
    expect(marker.circleRadius + marker.haloWidth / 2).toBeCloseTo(marker.outerRadius);
    expect(marker.crosshairRadius + marker.haloWidth / 2).toBeLessThan(marker.outerRadius);
    expect(marker.hitRadius).toBe(16);
  });

  it("measures perpendicular distance to a sloping boundary", () => {
    const triangle = [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 200 }];
    const marker = outletMarkerGeometry({ x: 100, y: 90 }, [triangle], [], 1);
    expect(marker.clearance).toBeCloseTo(10 / Math.sqrt(2));
    expect(marker.outerRadius).toBeLessThan(marker.clearance);
  });

  it("respects openings and concave notches rather than the bounding rectangle", () => {
    const hole = rectangle(100, 100, 180, 180);
    const nearHole = outletMarkerGeometry({ x: 190, y: 140 }, [roof], [hole], 1);
    expect(nearHole.clearance).toBe(10);
    expect(nearHole.outerRadius).toBeCloseTo(7.5);
    expect(outletMarkerGeometry({ x: 140, y: 140 }, [roof], [hole], 1).status).toBe("outside");
    expect(outletMarkerGeometry({ x: 100, y: 140 }, [roof], [hole], 1).status).toBe("outside");
    const concave = [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 80 },
      { x: 80, y: 80 }, { x: 80, y: 200 }, { x: 0, y: 200 }];
    expect(outletMarkerGeometry({ x: 150, y: 150 }, [concave], [], 1).status).toBe("outside");
    expect(outletMarkerGeometry({ x: 75, y: 100 }, [concave], [], 1).clearance).toBe(5);
  });

  it("allows full-circle overlap only at the actual outer perimeter", () => {
    for (const point of [{ x: 0, y: 0 }, { x: 0, y: 140 }, { x: 400, y: 400 }]) {
      for (const scale of [0.2, 1, 3]) {
        const marker = outletMarkerGeometry(point, [roof], [], scale);
        expect(marker.status).toBe("boundary");
        expect(marker.outerRadius * scale).toBe(12);
      }
    }
    const close = outletMarkerGeometry({ x: 0.001, y: 140 }, [roof], [], 1);
    expect(close.status).toBe("interior");
    expect(close.outerRadius).toBe(0);
  });

  it("uses the assigned roof and does not enlarge a marker using an overlapping neighbour", () => {
    const other = rectangle(-200, -200, 500, 500);
    const marker = outletMarkerGeometry({ x: 8, y: 20, outline_id: "roof-a" }, [roof, other], [], 1, ["roof-a", "roof-b"]);
    expect(marker.clearance).toBe(8);
    expect(marker.outerRadius).toBeCloseTo(5.5);
    expect(outletMarkerGeometry({ x: -10, y: 20, outline_id: "roof-a" }, [roof, other], [], 1,
      ["roof-a", "roof-b"]).status).toBe("outside");
  });

  it("does not impose an overflowing minimum radius at low zoom", () => {
    const marker = outletMarkerGeometry({ x: 5, y: 20 }, [roof], [], 0.2);
    expect(marker.status).toBe("interior");
    expect(marker.outerRadius).toBe(0);
    expect(marker.hitRadius).toBe(80);
  });

  it("draws a transparent blue circle/crosshair with a white halo and an inset selection ring", () => {
    const ctx = mockCanvasContext();
    const point = { x: 8, y: 6, review_status: "suggested" as const };
    const marker = outletMarkerGeometry(point, [roof], [], 1);
    drawOutletMarker(ctx as unknown as CanvasRenderingContext2D, point, marker, true);
    expect(ctx.fill).not.toHaveBeenCalled();
    expect(ctx.arc).toHaveBeenCalledWith(8, 6, marker.circleRadius, 0, Math.PI * 2);
    expect(ctx.setLineDash).toHaveBeenCalledWith([marker.strokeWidth * 2, marker.strokeWidth * 1.5]);
    const radii = ctx.arc.mock.calls.map(call => call[2] as number);
    expect(Math.max(...radii) + marker.haloWidth / 2).toBeCloseTo(marker.outerRadius);
    expect((ctx as unknown as CanvasRenderingContext2D).strokeStyle).toBe("#0077CC");
  });
});
