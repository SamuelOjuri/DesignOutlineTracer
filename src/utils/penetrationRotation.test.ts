import { describe, expect, it } from "vitest";
import { penetrationRotationDegrees, penetrationRotationHandle } from "./penetrationRotation";

describe("penetration rotation interaction geometry", () => {
  it("crosses the angle wrap without reversing direction", () => {
    const at = (degrees: number) => ({ x: 100 + 40 * Math.cos(degrees * Math.PI / 180), y: 100 + 40 * Math.sin(degrees * Math.PI / 180) });
    expect(penetrationRotationDegrees({ x: 100, y: 100 }, at(179), at(-179), false)).toBeCloseTo(2);
    expect(penetrationRotationDegrees({ x: 100, y: 100 }, at(-179), at(179), false)).toBeCloseTo(-2);
    expect(penetrationRotationDegrees({ x: 100, y: 100 }, at(0), at(23), true)).toBe(30);
  });

  it("keeps handle spacing constant on screen at different zoom levels", () => {
    const points = [{ x: 200, y: 200 }, { x: 300, y: 200 }, { x: 300, y: 300 }, { x: 200, y: 300 }];
    for (const scale of [.5, 1, 4]) {
      const { anchor, handle } = penetrationRotationHandle(points, { width: 800, height: 600 }, scale);
      expect(Math.hypot(anchor.x - handle.x, anchor.y - handle.y) * scale).toBeCloseTo(34);
    }
  });
});
