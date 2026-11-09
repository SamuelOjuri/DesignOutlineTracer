import { useId } from "react";
import type { Point } from "@/types/roof";
import type { VectorSnap } from "@/utils/polylineRedraw";
import { OUTLINE_APPEARANCE } from "@/utils/outlineAppearance";

interface AcceptedOutlineOverlayProps {
  outlines: readonly Point[][];
  holes: readonly Point[][];
  penetrationHoles: readonly Point[][];
  width: number;
  height: number;
  displayScale: number;
  showVertices: boolean;
  hoveredEdge: { outlineIndex: number; edgeIndex: number } | null;
  hoveredVertex: { outlineIndex: number; vertexIndex: number } | null;
  mergeTarget: Point | null;
  pdfSnap?: VectorSnap | null;
}

const polygonPoints = (points: readonly Point[]) => points.map(point => `${point.x},${point.y}`).join(" ");

export function AcceptedOutlineOverlay({ outlines, holes, penetrationHoles, width, height, displayScale,
  showVertices, hoveredEdge, hoveredVertex, mergeTarget, pdfSnap = null }: AcceptedOutlineOverlayProps) {
  const maskId = useId();
  const scale = Math.max(displayScale, 0.01);
  const openings = [...holes, ...penetrationHoles];
  const edge = hoveredEdge ? outlines[hoveredEdge.outlineIndex] : undefined;
  const edgeStart = edge && hoveredEdge ? edge[hoveredEdge.edgeIndex] : undefined;
  const edgeEnd = edge && hoveredEdge ? edge[(hoveredEdge.edgeIndex + 1) % edge.length] : undefined;

  return <svg viewBox={`0 0 ${width} ${height}`} width="100%" height="100%"
    className="pointer-events-none" role="img" aria-label="Accepted insulation outline"
    data-testid="accepted-outline-overlay">
    <defs>
      {/* White areas union the roof scopes; black openings subtract even when they overlap. */}
      <mask id={maskId} maskUnits="userSpaceOnUse" x={0} y={0} width={width} height={height}
        style={{ maskType: "luminance" }}>
        <rect width={width} height={height} fill="black" />
        {outlines.map((points, index) => <polygon key={`roof-${index}`} points={polygonPoints(points)} fill="white" />)}
        {openings.map((points, index) => <polygon key={`opening-${index}`} points={polygonPoints(points)} fill="black"
          data-outline-opening={index} />)}
      </mask>
    </defs>
    <rect width={width} height={height} fill={OUTLINE_APPEARANCE.stroke}
      fillOpacity={OUTLINE_APPEARANCE.acceptedFillOpacity} mask={`url(#${maskId})`} />
    {outlines.map((points, index) => <polygon key={index} points={polygonPoints(points)}
      data-accepted-outline={index} fill="none" stroke={OUTLINE_APPEARANCE.stroke}
      strokeWidth={OUTLINE_APPEARANCE.strokeWidth} strokeLinejoin="miter" strokeMiterlimit={4}
      vectorEffect="non-scaling-stroke" />)}
    {edgeStart && edgeEnd && <line x1={edgeStart.x} y1={edgeStart.y} x2={edgeEnd.x} y2={edgeEnd.y}
      stroke={OUTLINE_APPEARANCE.stroke} strokeWidth={OUTLINE_APPEARANCE.hoverStrokeWidth}
      vectorEffect="non-scaling-stroke" data-testid="outline-hovered-edge" />}
    {showVertices && outlines.flatMap((points, outlineIndex) => points.map((point, vertexIndex) => {
      const hovered = hoveredVertex?.outlineIndex === outlineIndex && hoveredVertex.vertexIndex === vertexIndex;
      return <circle key={`${outlineIndex}-${vertexIndex}`} cx={point.x} cy={point.y}
        r={(hovered ? 4.5 : 3) / scale} fill="white" stroke={OUTLINE_APPEARANCE.stroke} strokeWidth={1.5}
        vectorEffect="non-scaling-stroke" data-outline-vertex={`${outlineIndex}-${vertexIndex}`} />;
    }))}
    {mergeTarget && <circle cx={mergeTarget.x} cy={mergeTarget.y} r={8 / scale} fill="none"
      stroke="#00875a" strokeWidth={2} vectorEffect="non-scaling-stroke" data-testid="outline-merge-target" />}
    {pdfSnap && <>
      {pdfSnap.segments.map((segment, index) => <line key={index} x1={segment.start.x} y1={segment.start.y}
        x2={segment.end.x} y2={segment.end.y} stroke="#0f766e" strokeOpacity={0.7} strokeWidth={2}
        vectorEffect="non-scaling-stroke" data-testid="adjust-pdf-vector" />)}
      <circle cx={pdfSnap.point.x} cy={pdfSnap.point.y} r={6 / scale} fill="white"
        stroke="#0f766e" strokeWidth={2} vectorEffect="non-scaling-stroke"
        data-testid="adjust-pdf-snap" data-snap={pdfSnap.kind} />
      <text x={pdfSnap.point.x + 10 / scale} y={pdfSnap.point.y - 10 / scale} fontSize={12 / scale}
        fill="#134e4a" stroke="white" strokeWidth={3 / scale} paintOrder="stroke" fontWeight={600}>PDF {pdfSnap.kind}</text>
    </>}
  </svg>;
}
