import type { OutlineProposal } from "@/types/outline";

export function OutlineProposalOverlay({ proposals, width, height }: {
  proposals: readonly OutlineProposal[]; width: number; height: number;
}) {
  return <svg viewBox={`0 0 ${width} ${height}`} width="100%" height="100%"
    className="pointer-events-none" role="img" aria-label="Suggested insulation outline; orange dashed edges need review"
    data-testid="outline-proposal-overlay">
    {proposals.map((proposal, polygonIndex) => <g key={proposal.id}>
      <polygon points={proposal.points.map(point => `${point.x},${point.y}`).join(" ")}
        fill="rgba(37, 99, 235, 0.15)" stroke="none" />
      {proposal.points.map((point, index) => {
        const next = proposal.points[(index + 1) % proposal.points.length];
        const edge = proposal.edges.find(item => item.index === index);
        const uncertain = !edge || edge.ambiguous || edge.source === "unsupported" || edge.support < 0.55;
        return <line key={index} x1={point.x} y1={point.y} x2={next.x} y2={next.y}
          stroke={uncertain ? "#c2410c" : "#2563eb"} strokeWidth={3} vectorEffect="non-scaling-stroke"
          strokeDasharray={uncertain ? "7 4" : undefined} data-outline-edge={index} data-uncertain={uncertain}>
          <title>{`Outline ${polygonIndex + 1}, edge ${index + 1}${uncertain ? ": review boundary placement" : ""}`}</title>
        </line>;
      })}
    </g>)}
  </svg>;
}
