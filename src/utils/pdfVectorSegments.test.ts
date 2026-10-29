import { describe, expect, it } from "vitest";
import { OPS } from "pdfjs-dist";
import { extractPdfVectorSegments } from "./pdfVectorSegments";

describe("PDF vector evidence", () => {
  it("applies page rotation/crop and nested PDF transforms exactly once", () => {
    const result = extractPdfVectorSegments({ fnArray: [OPS.save, OPS.transform, OPS.constructPath, OPS.stroke, OPS.restore,
      OPS.constructPath, OPS.stroke], argsArray: [[], [2, 0, 0, 2, 10, 20],
      [[OPS.moveTo, OPS.lineTo], [5, 10, 20, 10]], [], [], [[OPS.moveTo, OPS.lineTo], [0, 0, 0, 10]], []] },
    [0, 1, 1, 0, 20, 30], 300, 300);
    expect(result).toEqual([{ start: { x: 60, y: 50 }, end: { x: 60, y: 80 } },
      { start: { x: 20, y: 30 }, end: { x: 30, y: 30 } }]);
  });
  it("does not substitute Bezier chords or use dashed and clipped marks as precise lines", () => {
    const result = extractPdfVectorSegments({ fnArray: [OPS.constructPath, OPS.stroke, OPS.setDash, OPS.constructPath, OPS.stroke,
      OPS.setDash, OPS.save, OPS.clip, OPS.constructPath, OPS.stroke, OPS.restore], argsArray: [
      [[OPS.moveTo, OPS.curveTo, OPS.lineTo], [10, 10, 15, 20, 25, 20, 30, 10, 50, 10]], [], [[2, 2], 0],
      [[OPS.moveTo, OPS.lineTo], [20, 20, 80, 20]], [], [[], 0], [], [], [[OPS.moveTo, OPS.lineTo], [20, 30, 80, 30]], [], []] },
    [1, 0, 0, 1, 0, 0], 100, 100);
    expect(result).toEqual([{ start: { x: 30, y: 10 }, end: { x: 50, y: 10 } }]);
  });
  it("retains vectors inside page clips and clips transformed Form XObjects without inventing borders", () => {
    const result = extractPdfVectorSegments({ fnArray: [OPS.constructPath, OPS.clip, OPS.endPath,
      OPS.paintFormXObjectBegin, OPS.constructPath, OPS.stroke, OPS.paintFormXObjectEnd, OPS.constructPath, OPS.stroke],
    argsArray: [[[OPS.rectangle], [0, 0, 100, 100]], [], [], [[1, 0, 0, 1, 20, 10], [0, 0, 40, 40]],
      [[OPS.moveTo, OPS.lineTo], [-10, 20, 60, 20]], [], [], [[OPS.moveTo, OPS.lineTo], [0, 80, 100, 80]], []] },
    [1, 0, 0, 1, 0, 0], 100, 100);
    expect(result).toEqual([{ start: { x: 20, y: 30 }, end: { x: 60, y: 30 } },
      { start: { x: 0, y: 80 }, end: { x: 100, y: 80 } }]);
  });
  it("keeps diagonal intersections inside strict source-page bounds despite roundoff", () => {
    const result = extractPdfVectorSegments({ fnArray: [OPS.constructPath, OPS.stroke],
      argsArray: [[[OPS.moveTo, OPS.lineTo], [-11.3, -7.7, 101.1, 103.9]], []] }, [1, 0, 0, 1, 0, 0], 100, 100);
    expect(result).toHaveLength(1);
    for (const point of [result[0].start, result[0].end]) {
      expect(point.x).toBeGreaterThanOrEqual(0); expect(point.x).toBeLessThanOrEqual(100);
      expect(point.y).toBeGreaterThanOrEqual(0); expect(point.y).toBeLessThanOrEqual(100);
    }
  });
});
