import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { Magnet } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Point } from "@/types/roof";
import type { VectorSegment } from "@/types/outline";
import { findClosestEdge, findClosestVertex, type OutlineEditResult } from "@/utils/polygonAdjust";
import { imageSideTargets, prepareSideFit, shorterSide, sideIndices, suggestSide, vectorSideTargets,
  type SideSection, type SideTarget } from "@/utils/sideFit";

interface FitSession {
  context: string;
  first: { outlineIndex: number; vertexIndex: number } | null;
  section: SideSection | null;
  targets: SideTarget[];
  targetIndex: number;
  locked: boolean;
}

interface SideFitOptions {
  enabled: boolean;
  outlines: Point[][];
  holes: Point[][];
  openings: Point[][];
  vectors: readonly VectorSegment[];
  source: HTMLCanvasElement;
  scale: number;
  onCommit: (edit: OutlineEditResult) => void;
  onActivate: () => void;
}

/** A separate, opt-in gesture surface leaves ordinary Adjust dragging unchanged. */
export function useSideFit({ enabled, outlines, holes, openings, vectors, source, scale, onCommit, onActivate }: SideFitOptions) {
  const context = JSON.stringify([outlines, holes, openings]);
  const [session, setSession] = useState<FitSession | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const image = useRef<ImageData | null>(null);
  const lastHover = useRef(0);
  const cancel = useCallback(() => { setSession(null); setHint(null); }, []);
  const active = enabled && session?.context === context;
  const current = active ? session : null;
  const target = current?.targets[current.targetIndex];
  const section = current?.section;
  const preview = useMemo(() => section && target
    ? prepareSideFit(outlines, holes, openings, section, target, source) : null,
  [outlines, holes, openings, section, target, source]);

  useEffect(() => { setSession(null); setHint(null); }, [enabled, context, source]);
  useEffect(() => { image.current = null; }, [source]);
  useEffect(() => {
    const cancel = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setSession(null); setHint(null); }
    };
    const blur = () => { setSession(null); setHint(null); };
    window.addEventListener("keydown", cancel);
    window.addEventListener("blur", blur);
    return () => { window.removeEventListener("keydown", cancel); window.removeEventListener("blur", blur); };
  }, []);

  const fresh = (): FitSession => ({ context, first: null, section: null, targets: [], targetIndex: 0, locked: false });
  const position = (event: ReactPointerEvent<SVGSVGElement>): Point => {
    const box = event.currentTarget.getBoundingClientRect();
    return { x: (event.clientX - box.left) * source.width / box.width, y: (event.clientY - box.top) * source.height / box.height };
  };
  const targetsAt = (point: Point): SideTarget[] => {
    if (!section) return [];
    const polygon = outlines[section.outlineIndex];
    const side = { start: polygon[section.start], end: polygon[section.end] };
    const targets = vectorSideTargets(vectors, side, point, 10 / scale);
    if (targets.length) return targets;
    // Sample only the source PDF, never the blue outline or green ROI overlays.
    if (!image.current) {
      try { image.current = source.getContext("2d")?.getImageData(0, 0, source.width, source.height) ?? null; }
      catch { return []; }
    }
    return image.current ? imageSideTargets(image.current, side, point, 10 / scale) : [];
  };
  const pick = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!current || event.button !== 0) return;
    event.preventDefault();
    const point = position(event);
    if (!section) {
      const vertex = findClosestVertex(point.x, point.y, outlines, 10 / scale);
      if (current.first) {
        if (!vertex || vertex.outlineIndex !== current.first.outlineIndex || vertex.vertexIndex === current.first.vertexIndex) {
          setHint("Choose a different end corner on the same outline."); return;
        }
        setSession({ ...current, first: null, section: { outlineIndex: vertex.outlineIndex,
          ...shorterSide(outlines[vertex.outlineIndex], current.first.vertexIndex, vertex.vertexIndex) } });
      } else if (vertex) {
        setSession({ ...current, first: vertex });
      } else {
        const edge = findClosestEdge(point.x, point.y, outlines, 12 / scale);
        if (!edge) { setHint("Click a blue side or an end corner."); return; }
        setSession({ ...current, section: { outlineIndex: edge.outlineIndex, ...suggestSide(outlines[edge.outlineIndex], edge.edgeIndex) } });
      }
      setHint(null);
    } else {
      const targets = targetsAt(point);
      setSession({ ...current, targets, targetIndex: 0, locked: targets.length > 0 });
      setHint(targets.length ? null : "No continuous line found here. Move closer to the intended boundary.");
    }
  };
  const hover = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!current || !section || current.locked || performance.now() - lastHover.current < 40) return;
    lastHover.current = performance.now();
    const targets = targetsAt(position(event));
    setSession({ ...current, targets, targetIndex: 0 });
    setHint(null);
  };
  const path = section ? sideIndices(outlines[section.outlineIndex].length, section.start, section.end)
    .map(index => outlines[section.outlineIndex][index]) : [];
  const points = (ring: Point[]) => ring.map(p => `${p.x},${p.y}`).join(" ");
  const message = hint ?? preview?.error ?? (!current ? ""
    : !section ? current.first ? "Click the other end corner." : "Click a side, or select its two end corners."
    : current.locked ? "Review the dashed preview, then Apply fit. Click another line to change the target."
    : "Click the drawing line to follow. Orange marks the section being replaced.");

  return {
    active,
    cancel,
    button: enabled ? <Button size="sm" variant="adjustTool" aria-pressed={active} title="Select a roof edge, then choose a line on the plan to snap it to."
        onClick={() => {
          if (active) cancel();
          else { onActivate(); setSession(fresh()); setHint(null); }
        }}>
        <Magnet className="w-4 h-4 mr-1" />Snap to line
      </Button> : null,
    controls: active ? <>
      {section && <>
        <Button size="sm" variant="ghost" onClick={() => { setSession(fresh()); setHint(null); }}>Change section</Button>
        <Button size="sm" variant="ghost" onClick={() => {
          setSession({ ...current!, section: { ...section, start: section.end, end: section.start }, targets: [], targetIndex: 0, locked: false });
          setHint(null);
        }}>Other path</Button>
        {current!.targets.length > 1 && <Button size="sm" variant="outline" onClick={() => {
          setSession({ ...current!, targetIndex: (current!.targetIndex + 1) % current!.targets.length, locked: true });
        }}>Next line ({current!.targetIndex + 1}/{current!.targets.length})</Button>}
        <Button size="sm" disabled={!current!.locked || !preview || Boolean(preview.error)} onClick={() => {
          if (preview && !preview.error && current?.context === context) { onCommit(preview); setSession(null); setHint(null); }
        }}>Apply fit</Button>
      </>}
      {active && <Button size="sm" variant="ghost" onClick={() => { setSession(null); setHint(null); }}>Cancel fit</Button>}
      {active && <span role="status" className={`text-xs ${preview?.error ? "text-destructive" : "text-muted-foreground"}`}>{message}</span>}
    </> : null,
    overlay: current ? <svg viewBox={`0 0 ${source.width} ${source.height}`} width="100%" height="100%"
      data-testid="side-fit-overlay" aria-label="Snap to line: select a roof edge and a drawing line"
      className="pointer-events-auto cursor-crosshair" style={{ touchAction: "none" }}
      onPointerDown={pick} onPointerMove={hover} onPointerLeave={() => {
        if (!current.locked) setSession({ ...current, targets: [], targetIndex: 0 });
      }}>
      <rect width={source.width} height={source.height} fill="transparent" />
      {path.length > 0 && <polyline points={points(path)} fill="none" stroke="#c2410c" strokeWidth={4}
        strokeDasharray="6 4" vectorEffect="non-scaling-stroke" data-testid="side-fit-section" />}
      {(current.first ? [outlines[current.first.outlineIndex][current.first.vertexIndex]] : path.length ? [path[0], path[path.length - 1]] : [])
        .map((p, i) => <circle key={i} cx={p.x} cy={p.y} r={5 / scale} fill="white" stroke="#c2410c" strokeWidth={2} vectorEffect="non-scaling-stroke" />)}
      {target && <line x1={target.start.x} y1={target.start.y} x2={target.end.x} y2={target.end.y}
        stroke="#0f766e" strokeWidth={3} vectorEffect="non-scaling-stroke" data-testid="side-fit-target" data-source={target.source} />}
      {preview && !preview.error && <polygon points={points(preview.outlines[section!.outlineIndex])}
        fill="#7c3aed" fillOpacity={0.06} stroke="#7c3aed" strokeWidth={2} strokeDasharray="5 3"
        vectorEffect="non-scaling-stroke" data-testid="side-fit-preview" />}
    </svg> : null,
  };
}
