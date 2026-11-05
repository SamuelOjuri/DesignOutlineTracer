import { describe, expect, it } from "vitest";
import type { Point } from "@/types/roof";
import { imageSideTargets, parallelSegments, prepareSideFit, sameLine, shorterSide, sideIndices, stickyTargetIndex, suggestSide,
  vectorSideTargets } from "./sideFit";

const roof = [{ x: 40, y: 40 }, { x: 190, y: 40 }, { x: 190, y: 48 }, { x: 202, y: 48 },
  { x: 202, y: 160 }, { x: 198, y: 260 }, { x: 40, y: 260 }];
const bounds = { width: 1000, height: 1000 };
const line = { start: { x: 200, y: 40 }, end: { x: 200, y: 260 } };
const section = { outlineIndex: 0, start: 1, end: 5 };
const expected = [{ x: 40, y: 40 }, { x: 200, y: 40 }, { x: 200, y: 260 }, { x: 40, y: 260 }];
const hole = [{ x: 70, y: 80 }, { x: 90, y: 80 }, { x: 90, y: 100 }, { x: 70, y: 100 }];

describe("guided side fitting", () => {
  it("replaces a selected stepped/bent chain with intersecting corners, leaving other roofs and cutouts intact", () => {
    const other = expected.map(p => ({ x: p.x + 300, y: p.y }));
    const original = JSON.stringify([roof, other, hole]);
    expect(suggestSide(roof, 3)).toEqual({ start: 1, end: 5 });
    const edit = prepareSideFit([roof, other], [hole], [], section, line, bounds);
    expect(edit.error).toBeNull();
    expect(edit.outlines).toEqual([expected, other]);
    expect(edit.holes).toEqual([hole]);
    expect(edit.editedOutlineIndex).toBe(0);
    expect(JSON.stringify([roof, other, hole])).toBe(original);
  });

  it.each([0, 31, 90, 147])("fits rotated sides at %s degrees, either winding and rescaled", degrees => {
    for (const factor of [0.5, 2]) for (const reversed of [false, true]) {
      const transform = (p: Point) => ({ x: 1000 + factor * (p.x * Math.cos(degrees * Math.PI / 180) - p.y * Math.sin(degrees * Math.PI / 180)),
        y: 1000 + factor * (p.x * Math.sin(degrees * Math.PI / 180) + p.y * Math.cos(degrees * Math.PI / 180)) });
      const rotated = roof.map(transform);
      const ring = reversed ? [...rotated].reverse() : rotated;
      const selected = reversed ? { outlineIndex: 0, start: 1, end: 5 } : section;
      const edit = prepareSideFit([ring], [], [], selected, { start: transform(line.start), end: transform(line.end) }, { width: 2000, height: 2000 });
      expect(edit.error).toBeNull();
      const target = reversed ? [...expected].reverse().map(transform) : expected.map(transform);
      expect(edit.outlines[0]).toHaveLength(4);
      edit.outlines[0].forEach((point, index) => {
        expect(point.x).toBeCloseTo(target[index].x, 7);
        expect(point.y).toBeCloseTo(target[index].y, 7);
      });
    }
  });

  it("handles wraparound and explicit paths without removing steps on other sides", () => {
    const shifted = [...roof.slice(4), ...roof.slice(0, 4)];
    expect(sideIndices(shifted.length, 4, 1)).toEqual([4, 5, 6, 0, 1]);
    expect(shorterSide(shifted, 1, 4)).toEqual({ start: 4, end: 1 });
    const result = prepareSideFit([shifted], [], [], { outlineIndex: 0, start: 4, end: 1 }, line, bounds);
    expect(result.error).toBeNull();
    expect(result.outlines[0]).toEqual([expected[2], expected[3], expected[0], expected[1]]);
    const partial = prepareSideFit([roof], [], [], { ...section, start: 3 }, line, bounds);
    expect(partial.error).toBeNull();
    expect(partial.outlines[0].slice(0, 3)).toEqual(roof.slice(0, 3));
  });

  it("does not silently remove a genuine large return from the suggested section", () => {
    const stepped = [{ x: 40, y: 40 }, { x: 140, y: 40 }, { x: 140, y: 120 },
      { x: 220, y: 120 }, { x: 220, y: 260 }, { x: 40, y: 260 }];
    expect(suggestSide(stepped, 3)).toEqual({ start: 3, end: 4 });
  });

  it("blocks collisions, changed cutouts/openings, unstable intersections, and off-page targets", () => {
    const target = { start: { x: 210, y: 40 }, end: { x: 210, y: 260 } };
    const neighbour = [{ x: 207, y: 80 }, { x: 230, y: 80 }, { x: 230, y: 120 }, { x: 207, y: 120 }];
    expect(prepareSideFit([roof, neighbour], [], [], section, target, bounds).error).toMatch(/touch or overlap/);
    const crossingHole = hole.map(p => ({ x: p.x + 115, y: p.y }));
    for (const opening of [false, true]) {
      expect(prepareSideFit([roof], opening ? [] : [crossingHole], opening ? [crossingHole] : [], section,
        { start: { x: 195, y: 40 }, end: { x: 195, y: 260 } }, bounds).error).toMatch(/cutout, opening/);
    }
    expect(prepareSideFit([roof], [], [], section, line, { width: 199, height: 300 }).error).toMatch(/drawing page/);
    expect(prepareSideFit([roof], [], [], section, { start: { x: 0, y: 40 }, end: { x: 200, y: 40 } }, bounds).error).toMatch(/same direction/);
    expect(prepareSideFit([roof], [], [], { ...section, start: 2 }, line, bounds).error).toMatch(/stable corner/);
    expect(prepareSideFit([roof], [], [], { ...section, end: 0 }, line, bounds).error).toMatch(/two other edges/);
  });

  it("repairs the stored TP17202 lower-roof side without relying on its filename or orientation", () => {
    const captured = [{ x: 561.6059007866738, y: 1085.5017056915904 }, { x: 562.32, y: 909.1192 },
      { x: 641.28, y: 909.8392 }, { x: 641.28, y: 916.0792 }, { x: 651.2295145631069, y: 916.0792 },
      { x: 649.4564396895832, y: 1053.049233979697 }, { x: 644.1323905699936, y: 1053.4790844869474 },
      { x: 645.2012655267313, y: 1086.003422456249 }];
    const chosen = suggestSide(captured, 4);
    expect(chosen).toEqual({ start: 2, end: 7 });
    const result = prepareSideFit([captured], [], [], { outlineIndex: 0, ...chosen },
      { start: { x: 651, y: 909 }, end: { x: 651, y: 1086 } }, { width: 2382, height: 1684 });
    expect(result.error).toBeNull();
    expect(result.outlines[0]).toHaveLength(4);
    expect(result.outlines[0].slice(0, 2)).toEqual(captured.slice(0, 2));
    expect(result.outlines[0][2].x).toBeCloseTo(651);
    expect(result.outlines[0][3].x).toBeCloseTo(651);
  });
});

describe("drawing line candidates", () => {
  it("merges finite collinear pieces, ranks parallel faces by pointer distance and rejects short details", () => {
    const segments = [{ start: { x: 200, y: 40 }, end: { x: 200, y: 140 } },
      { start: { x: 200, y: 145 }, end: { x: 200, y: 260 } },
      { start: { x: 204, y: 40 }, end: { x: 204, y: 260 } },
      { start: { x: 201, y: 145 }, end: { x: 201, y: 155 } },
      { start: { x: 100, y: 150 }, end: { x: 205, y: 150 } }];
    const targets = vectorSideTargets(segments, line, { x: 200.5, y: 150 }, 6);
    expect(targets.map(t => t.start.x)).toEqual([200, 204]);
    expect(targets[0].support).toBeGreaterThan(0.95);
    expect(vectorSideTargets(segments, line, { x: 200, y: 350 }, 6)).toEqual([]);
    expect(vectorSideTargets([{ start: line.start, end: line.start }], line, line.start, 6)).toEqual([]);
  });

  it("finds a line by its offset beside the side, even where the drawing has a gap under the pointer", () => {
    const opening = [{ start: { x: 210, y: 40 }, end: { x: 210, y: 120 } }, { start: { x: 210, y: 160 }, end: { x: 210, y: 260 } }];
    const targets = vectorSideTargets(opening, line, { x: 211, y: 140 }, 6);
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ start: { x: 210, y: 40 }, end: { x: 210, y: 260 }, source: "vector" });
    expect(targets[0].support).toBeCloseTo(180 / 220);
    expect(vectorSideTargets(opening, line, { x: 211, y: 36 }, 6)).toHaveLength(1);
    expect(vectorSideTargets(opening, line, { x: 211, y: 20 }, 6)).toEqual([]);
    expect(vectorSideTargets([{ start: { x: 210, y: 300 }, end: { x: 210, y: 500 } }], line, { x: 210, y: 140 }, 6)).toEqual([]);
  });

  it("pre-filters parallel segments once without changing the candidates", () => {
    const segments = [{ start: { x: 200, y: 40 }, end: { x: 200, y: 260 } }, { start: { x: 100, y: 150 }, end: { x: 300, y: 150 } },
      { start: { x: 204, y: 40 }, end: { x: 214, y: 260 } }, { start: { x: 50, y: 50 }, end: { x: 50, y: 50 } }];
    const parallel = parallelSegments(segments, line);
    expect(parallel).toEqual([segments[0], segments[2]]);
    expect(vectorSideTargets(parallel, line, { x: 201, y: 150 }, 6)).toEqual(vectorSideTargets(segments, line, { x: 201, y: 150 }, 6));
    expect(parallelSegments(segments, { start: line.start, end: line.start })).toEqual([]);
  });

  it("keeps the previewed line until another line is clearly closer", () => {
    const faces = [195, 198].map(x => ({ start: { x, y: 40 }, end: { x, y: 260 } }));
    const nearest = (x: number) => [...faces].sort((a, b) => Math.abs(a.start.x - x) - Math.abs(b.start.x - x));
    expect(sameLine(faces[0], { start: { x: 195.2, y: 300 }, end: { x: 195.2, y: 0 } })).toBe(true);
    expect(sameLine(faces[0], faces[1])).toBe(false);
    expect(stickyTargetIndex(nearest(196), undefined, { x: 196, y: 150 }, 1)).toBe(0);
    expect(stickyTargetIndex(nearest(196.4), faces[1], { x: 196.4, y: 150 }, 1)).toBe(1);
    expect(stickyTargetIndex(nearest(195.2), faces[1], { x: 195.2, y: 150 }, 1)).toBe(0);
    expect(stickyTargetIndex(nearest(196), { start: { x: 230, y: 40 }, end: { x: 230, y: 260 } }, { x: 196, y: 150 }, 1)).toBe(0);
  });

  it("finds a continuous scanned stroke and ignores red dimensions and dashed fragments", () => {
    const image = { width: 300, height: 300, data: new Uint8ClampedArray(300 * 300 * 4).fill(255) };
    for (let y = 40; y <= 260; y++) {
      image.data.set([20, 20, 20, 255], (y * 300 + 200) * 4);
      image.data.set([255, 0, 0, 255], (y * 300 + 205) * 4);
      if (y % 16 < 4) image.data.set([0, 0, 0, 255], (y * 300 + 210) * 4);
    }
    const targets = imageSideTargets(image, line, { x: 201, y: 150 }, 10);
    expect(targets.length).toBeGreaterThan(0);
    expect(targets[0].start.x).toBeCloseTo(200, 1);
    expect(targets[0].end.x).toBeCloseTo(200, 1);
    expect(targets[0].source).toBe("image");
    expect(targets.every(t => Math.abs(t.start.x - 205) > 2 && Math.abs(t.start.x - 210) > 2)).toBe(true);
  });
});
