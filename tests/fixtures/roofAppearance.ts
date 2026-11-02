import type { DrainageEdge, Outlet, Point } from "../../src/types/roof";

export interface RoofAppearanceFixture {
  outlineIds: string[];
  roofOutlines: Point[][];
  interiorHoles: Point[][];
  outlets: Outlet[];
  drainageEdges: DrainageEdge[];
}

/** Geometry only from TPID_roof_20261102-1833; no project/contact details. */
export function tp17221Illustration(): RoofAppearanceFixture {
  const mmPerUnit = 17.638422818791945;
  const point = ([x, y]: number[]) => ({ x: x / mmPerUnit, y: (17585.4 - y) / mmPerUnit });
  const rectangle = (left: number, bottom: number, right: number, top: number) =>
    [[left, top], [right, top], [right, bottom], [left, bottom]].map(point);
  return {
    outlineIds: ["roof-example"],
    roofOutlines: [[[0, 9404.3], [11873.3, 9387.3], [11718.1, 17585.4], [25023.1, 17423.4],
      [24984.6, 14912.1], [42751.3, 14907.2], [42751.3, 4724.3], [17144.5, 4724.3],
      [17144.5, 0], [5261.9, 0], [5266.1, 6976.3], [0, 6976.3]].map(point)],
    interiorHoles: [rectangle(16370.7, 8114.9, 18473.2, 12273.4), rectangle(23771.5, 7936.7, 25958.1, 12035.8),
      rectangle(28817.5, 7936.7, 31004.1, 12035.8), rectangle(33863.5, 7936.7, 36050.1, 12035.8),
      rectangle(38993.6, 7936.7, 41180.2, 12035.8)],
    outlets: [[178, 7454.7], [5660, 307.2], [16711.1, 307.2], [22216.4, 4933.3], [42335, 4933.3]]
      .map((position, index) => ({ ...point(position), id: `outlet-${index}`, outline_id: "roof-example",
        diameter: 0.15, review_status: "accepted", validity: "current" })),
    drainageEdges: [],
  };
}

/** Geometry only from TPID_roof_20261102-1915, including the two vanishing edge inlets. */
export function tp17221BoundaryIllustration(): RoofAppearanceFixture {
  const mmPerUnit = 17.638422818791945;
  const point = ([x, y]: number[]) => ({ x: x / mmPerUnit, y: (17573.1 - y) / mmPerUnit });
  const rectangle = (left: number, bottom: number, right: number, top: number) =>
    [[left, top], [right, top], [right, bottom], [left, bottom]].map(point);
  return {
    outlineIds: ["roof-example"],
    roofOutlines: [[[0, 9413.3], [11872.8, 9413.3], [11718.3, 17573.1], [25023.1, 17426.2],
      [24985.2, 14947.5], [42751.3, 14947.5], [42751.3, 4724.3], [17144.5, 4724.3],
      [17144.5, 0], [5261.9, 0], [5266.1, 6976.3], [0, 6976.3]].map(point)],
    interiorHoles: [rectangle(16454.8, 8174.4, 18473.2, 12273.4), rectangle(23771.5, 7936.7, 25789.9, 12035.8),
      rectangle(28901.6, 7936.7, 30920, 12035.8), rectangle(33947.6, 7936.7, 36050.1, 12035.8),
      rectangle(39077.7, 7936.7, 41180.2, 12035.8)],
    outlets: [[16.2, 7410.8], [5680.9, 197.6], [16727.2, 197.6], [22230.1, 4779.9], [42335, 4933.3]]
      .map((position, index) => ({ ...point(position), id: `outlet-${index}`, outline_id: "roof-example",
        diameter: 0.15, subtype: "parapet_outlet", review_status: "accepted", validity: "current" })),
    drainageEdges: [],
  };
}

/** Source-pixel inlet centres fitted offline from the five TP17221 cyan boxes.
 * Uses the benchmark scope and the existing reviewed opening geometry.
 */
export function tp17221FittedInlets(): RoofAppearanceFixture {
  const baseline = tp17221BoundaryIllustration();
  return { ...baseline,
    roofOutlines: [[[816.96, 2088.08], [1470.5, 2088.08], [1470.5, 1624.4], [2233.5, 1624.4],
      [2233.5, 1773.2], [3240.72, 1773.2], [3240.72, 2351.12], [1788.96, 2351.12],
      [1788.96, 2618.96], [1115.4, 2618.96], [1115.4, 2223.44], [816.96, 2223.44]]
      .map(([x, y]) => ({ x, y }))],
    interiorHoles: baseline.interiorHoles.map(ring => ring.map(point => ({ x: point.x + 816.96, y: point.y + 1624.4 }))),
    outlets: [[826, 2200.5], [1138.5, 2610], [1766, 2610], [2077, 2342], [3217.5, 2342]]
      .map(([x, y], index) => ({ ...baseline.outlets[index], x, y })),
  };
}
