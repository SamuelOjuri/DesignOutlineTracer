import { describe, expect, it } from "vitest";
import { drawOutletMarker, outletMarkerGeometry, outletMarkerGeometries, PENDING_RING_GAP } from "./outletMarker";
import { mockCanvasContext } from "@/test/canvas";

const rectangle = (left: number, top: number, right: number, bottom: number) => [
  { x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom },
];
const roof = rectangle(0, 0, 400, 400);
const partialArcs = (ctx: ReturnType<typeof mockCanvasContext>) => ctx.arc.mock.calls
  .filter(([, , , start, end]) => (end as number) - (start as number) < Math.PI * 2 - 1e-9);

/** Pending rings are four solid arcs centred on the crosshair arms, never a fine dash pattern. */
function expectBrokenRing(ctx: ReturnType<typeof mockCanvasContext>, x: number, y: number, radius: number) {
  const sweep = Math.PI / 2 - PENDING_RING_GAP;
  const arcs = partialArcs(ctx);
  expect(arcs).toHaveLength(4);
  arcs.forEach(([cx, cy, r, start, end], quadrant) => {
    expect([cx, cy]).toEqual([x, y]);
    expect(r).toBeCloseTo(radius);
    expect((end as number) - (start as number)).toBeCloseTo(sweep);
    expect(((start as number) + (end as number)) / 2).toBeCloseTo(quadrant * Math.PI / 2);
  });
  expect(ctx.setLineDash.mock.calls.every(([dash]) => (dash as number[]).length === 0)).toBe(true);
}

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
    const marker = outletMarkerGeometry({ x: 12, y: 10 }, [roof], [], 1);
    expect(marker.status).toBe("interior");
    expect(marker.clearance).toBe(10);
    expect(marker.outerRadius).toBeCloseTo(7.5);
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

  it("uses compact perimeter symbols and keeps almost-on-edge interior anchors visible", () => {
    for (const point of [{ x: 0, y: 0 }, { x: 0, y: 140 }, { x: 400, y: 400 }]) {
      for (const scale of [0.2, 1, 3]) {
        const marker = outletMarkerGeometry(point, [roof], [], scale);
        expect(marker.status).toBe("boundary");
        expect(marker.outerRadius * scale).toBe(6);
      }
    }
    const close = outletMarkerGeometry({ x: 0.001, y: 140 }, [roof], [], 1);
    expect(close.status).toBe("interior");
    expect(close.outerRadius).toBe(6);
  });

  it("reserves the same screen-space boundary stroke and gap across zoom", () => {
    for (const scale of [0.2, 1, 3]) {
      const marker = outletMarkerGeometry({ x: 200, y: 10 / scale }, [roof], [], scale, [], 5 / scale);
      expect(marker.status).toBe("interior");
      expect(marker.outerRadius * scale).toBeCloseTo(6.5);
      expect((marker.clearance - marker.outerRadius) * scale).toBeCloseTo(3.5);
    }
  });

  it("keeps outside suggestions compact and broken-ringed without changing their anchors or physical diameter", () => {
    const outlet = Object.freeze({ x: -1, y: 140, diameter: 0.15, diameter_confirmed: false,
      outline_id: "roof-a", review_status: "suggested" as const, validity: "needs_review" as const });
    const original = { ...outlet };
    for (const scale of [0.2, 1, 3]) {
      const marker = outletMarkerGeometry(outlet, [roof], [], scale, ["roof-a"]);
      expect(marker.status).toBe("outside");
      expect(marker.outerRadius * scale).toBeCloseTo(6);
      expect(marker.hitRadius * scale).toBeCloseTo(16);
      const ctx = mockCanvasContext();
      drawOutletMarker(ctx as unknown as CanvasRenderingContext2D, outlet, marker, true);
      expect(ctx.arc).toHaveBeenCalledWith(-1, 140, expect.closeTo(5 / scale), 0, Math.PI * 2);
      expectBrokenRing(ctx, -1, 140, 5 / scale);
    }
    expect(outlet).toEqual(original);
  });

  it("uses the assigned roof and does not enlarge a marker using an overlapping neighbour", () => {
    const other = rectangle(-200, -200, 500, 500);
    const marker = outletMarkerGeometry({ x: 10, y: 20, outline_id: "roof-a" }, [roof, other], [], 1, ["roof-a", "roof-b"]);
    expect(marker.clearance).toBe(10);
    expect(marker.outerRadius).toBeCloseTo(7.5);
    expect(outletMarkerGeometry({ x: -10, y: 20, outline_id: "roof-a" }, [roof, other], [], 1,
      ["roof-a", "roof-b"]).status).toBe("outside");
  });

  it("keeps suggested, accepted and manual near-edge symbols legible at every zoom without moving their anchors", () => {
    for (const review_status of [undefined, "suggested", "accepted"] as const) {
      for (const scale of [0.1, 0.27, 0.5, 1, 2.28, 3]) {
        const point = Object.freeze({ x: 0.001, y: 20, review_status });
        const marker = outletMarkerGeometry(point, [roof], [], scale);
        expect(marker.status).toBe("interior");
        expect(marker.outerRadius * scale).toBeCloseTo(6);
        expect(marker.strokeWidth * scale).toBeCloseTo(1);
        expect(marker.hitRadius * scale).toBeCloseTo(16);
        const ctx = mockCanvasContext();
        drawOutletMarker(ctx as unknown as CanvasRenderingContext2D, point, marker);
        expect(ctx.arc).toHaveBeenCalledWith(0.001, 20, expect.closeTo(5 / scale), 0, Math.PI * 2);
      }
    }
  });

  it("draws a transparent magenta circle/crosshair with a white halo and an inset selection ring", () => {
    const ctx = mockCanvasContext();
    const point = { x: 8, y: 6, review_status: "suggested" as const };
    const marker = outletMarkerGeometry(point, [roof], [], 1);
    drawOutletMarker(ctx as unknown as CanvasRenderingContext2D, point, marker, true);
    expect(ctx.fill).not.toHaveBeenCalled();
    expect(ctx.arc).toHaveBeenCalledWith(8, 6, marker.circleRadius, 0, Math.PI * 2);
    expectBrokenRing(ctx, 8, 6, marker.circleRadius);
    const radii = ctx.arc.mock.calls.map(call => call[2] as number);
    expect(Math.max(...radii) + marker.haloWidth / 2).toBeCloseTo(marker.outerRadius);
    expect((ctx as unknown as CanvasRenderingContext2D).strokeStyle).toBe("#C000A0");
  });

  it("keeps pending ring gaps open at the compact size and draws accepted rings continuously", () => {
    for (const scale of [0.27, 1, 3]) {
      const pending = { x: -1, y: 140, review_status: "suggested" as const };
      const marker = outletMarkerGeometry(pending, [roof], [], scale);
      const ctx = mockCanvasContext();
      const strokes: { colour: unknown; cap: string }[] = [];
      ctx.stroke.mockImplementation(() => {
        const state = ctx as unknown as CanvasRenderingContext2D;
        strokes.push({ colour: state.strokeStyle, cap: state.lineCap });
      });
      drawOutletMarker(ctx as unknown as CanvasRenderingContext2D, pending, marker);
      // Butt caps do not eat into the gap, so each gap stays at least 2.5 CSS pixels wide.
      expect(strokes).toContainEqual({ colour: "#C000A0", cap: "butt" });
      expect(marker.circleRadius * scale * PENDING_RING_GAP).toBeGreaterThanOrEqual(2.5);

      const accepted = { x: 200, y: 200, review_status: "accepted" as const };
      const acceptedCtx = mockCanvasContext();
      drawOutletMarker(acceptedCtx as unknown as CanvasRenderingContext2D, accepted,
        outletMarkerGeometry(accepted, [roof], [], scale));
      expect(partialArcs(acceptedCtx)).toHaveLength(0);
    }
  });
});

describe("uniform reviewed outlet markers", () => {
  const accepted = (x: number, y: number, outline_id = "roof-a") =>
    ({ x, y, outline_id, review_status: "accepted" as const, validity: "current" as const });

  it("uses one legible footprint near edges, corners and openings at every zoom", () => {
    const outlets = [accepted(20, 40), accepted(35, 35), accepted(200, 200), accepted(195, 140)];
    const holes = [rectangle(100, 100, 180, 180)];
    const original = JSON.stringify(outlets);
    for (const zoom of [0.2, 0.65, 1, 3]) {
      const markers = outletMarkerGeometries(outlets, [roof], holes, zoom, ["roof-a"]);
      expect(markers[0].outerRadius).toBeGreaterThan(0);
      for (const marker of markers) {
        expect(marker.outerRadius).toBeCloseTo(markers[0].outerRadius);
        expect(marker.circleRadius).toBeCloseTo(markers[0].circleRadius);
        expect(marker.strokeWidth).toBeCloseTo(markers[0].strokeWidth);
        expect(marker.outerRadius * zoom).toBeGreaterThanOrEqual(6);
        expect(marker.circleRadius + marker.haloWidth / 2).toBeLessThanOrEqual(Math.max(marker.clearance, 6 / zoom));
        expect(marker.hitRadius * zoom).toBe(16);
      }
    }
    expect(JSON.stringify(outlets)).toBe(original);
  });

  it("shares one size across roofs and excludes pending, stale and outside points from sizing", () => {
    const other = rectangle(500, 0, 900, 400);
    const outlets = [accepted(10, 20), accepted(200, 200), accepted(700, 200, "roof-b"),
      { ...accepted(4, 20), review_status: "suggested" as const },
      { ...accepted(4, 40), validity: "needs_review" as const },
      accepted(-10, 20), { x: 700, y: 300 }];
    const markers = outletMarkerGeometries(outlets, [roof, other], [], 1, ["roof-a", "roof-b"]);
    expect(markers[0].outerRadius).toBe(7.5);
    expect(markers[1].outerRadius).toBe(7.5);
    expect(markers[2].outerRadius).toBe(7.5);
    expect(markers[2].strokeWidth).toBeCloseTo(markers[0].strokeWidth);
    expect(markers[6].outerRadius).toBe(7.5);
    expect(markers[3].outerRadius).toBe(6);
    expect(markers[4].outerRadius).toBe(6);
    expect(markers[5].status).toBe("outside");
    expect(markers[5].outerRadius).toBe(6);
    const isolated = outletMarkerGeometries([accepted(700, 200, "roof-b")], [roof, other], [], 1, ["roof-a", "roof-b"]);
    expect(isolated[0].outerRadius).toBe(12);
  });

  it("groups manual and accepted boundary anchors without changing their positions or physical diameters", () => {
    const outlets = [{ ...accepted(20, 20), diameter: 0.15 },
      { x: 200, y: 200, diameter: 0.3 }, { ...accepted(0, 60), diameter: 0.1 }];
    const original = JSON.stringify(outlets);
    const markers = outletMarkerGeometries(outlets, [roof], [], 1, ["roof-a"]);
    expect(markers.map(marker => marker.outerRadius)).toEqual([6, 6, 6]);
    expect(markers[2].status).toBe("boundary");
    expect(JSON.stringify(outlets)).toBe(original);
  });
});
