import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { Magnet } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Point } from "@/types/roof";
import type { VectorSegment } from "@/types/outline";
import { findClosestEdge, findClosestVertex, type OutlineEditResult } from "@/utils/polygonAdjust";
import { imageSideTargets, parallelSegments, prepareSideFit, shorterSide, sideIndices, stickyTargetIndex, suggestSide,
  vectorSideTargets, type SideSection, type SideTarget } from "@/utils/sideFit";

interface Corner { outlineIndex: number; vertexIndex: number }

interface FitSession {
  context: string;
  first: Corner | null;
  section: SideSection | null;
  targets: SideTarget[];
  targetIndex: number;
  /** The fit for the highlighted line: exactly what Apply fit or a drag release commits. */
  preview: OutlineEditResult | null;
  locked: boolean;
}

interface FitDrag {
  pointerId: number;
  element: SVGSVGElement;
  origin: Point;
  /** The press chose the section, so an unsuccessful drag discards it again. */
  grabbed: boolean;
  moved: boolean;
}

type Grab = { context: string } & ({ corner: Corner } | { section: SideSection });

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

const AIM_INTERVAL_MS = 40;
/** Screen pixels a press must travel to become a drag; shorter presses keep the click-to-review flow. */
const DRAG_THRESHOLD = 3;
/** Screen pixels another line must be closer by before the previewed line changes. */
const STICKY_DISTANCE = 3;
const NO_LINE = "No continuous line found here. Move closer to the intended boundary.";

const blank = (context: string): FitSession =>
  ({ context, first: null, section: null, targets: [], targetIndex: 0, preview: null, locked: false });
const samePoint = (a: Point, b: Point) => a.x === b.x && a.y === b.y;

/**
 * A separate, opt-in gesture surface leaves ordinary Adjust dragging unchanged. Drag a side onto a drawing line
 * and release to apply the previewed fit; a click instead selects the side (or line) for review with Apply fit.
 * The tool stays on after each fit so several sides can be snapped in turn.
 */
export function useSideFit({ enabled, outlines, holes, openings, vectors, source, scale, onCommit, onActivate }: SideFitOptions) {
  const context = JSON.stringify([outlines, holes, openings]);
  const [armed, setArmed] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const [grab, setGrab] = useState<Grab | null>(null);
  const [, setVersion] = useState(0);
  // Pointer handlers and the trailing aim timer read the live session rather than a render-time copy.
  const store = useRef<FitSession>(blank(context));
  const drag = useRef<FitDrag | null>(null);
  const pending = useRef<Point | null>(null);
  const aimedAt = useRef<Point | null>(null);
  const lastAim = useRef(0);
  const timer = useRef<number | null>(null);
  const image = useRef<ImageData | null>(null);
  const parallel = useRef<{ vectors: readonly VectorSegment[]; key: string; segments: VectorSegment[] } | null>(null);

  const stopTracking = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    pending.current = null;
  }, []);
  const endDrag = useCallback(() => {
    const active = drag.current;
    drag.current = null;
    if (active?.element.hasPointerCapture?.(active.pointerId)) active.element.releasePointerCapture(active.pointerId);
    return active;
  }, []);
  const cancel = useCallback(() => {
    endDrag();
    stopTracking();
    store.current = blank(store.current.context);
    setArmed(false);
    setHint(null);
    setGrab(null);
  }, [endDrag, stopTracking]);

  useEffect(() => { cancel(); }, [enabled, source, cancel]);
  useEffect(() => { image.current = null; }, [source]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") cancel(); };
    window.addEventListener("keydown", escape);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("keydown", escape);
      window.removeEventListener("blur", cancel);
      stopTracking();
    };
  }, [cancel, stopTracking]);

  const active = enabled && armed;
  // Any geometry change (a fit, Undo or another edit) clears the selection but keeps the tool on.
  const live = (): FitSession => store.current.context === context ? store.current : blank(context);
  const current = active ? live() : null;
  const section = current?.section ?? null;
  const target = current?.targets[current.targetIndex];
  const preview = current?.preview ?? null;
  const dragging = Boolean(current && drag.current?.moved);
  const hovered = current && !section && grab?.context === context ? grab : null;
  const update = (next: FitSession) => { store.current = next; setVersion(version => version + 1); };

  const position = (event: ReactPointerEvent<SVGSVGElement>): Point => {
    const box = event.currentTarget.getBoundingClientRect();
    return { x: (event.clientX - box.left) * source.width / box.width, y: (event.clientY - box.top) * source.height / box.height };
  };
  const pathOf = (chosen: SideSection) => {
    const polygon = outlines[chosen.outlineIndex];
    return polygon ? sideIndices(polygon.length, chosen.start, chosen.end).map(index => polygon[index]) : [];
  };
  const segmentsBeside = (side: VectorSegment) => {
    const key = `${side.start.x},${side.start.y},${side.end.x},${side.end.y}`;
    if (parallel.current?.vectors !== vectors || parallel.current.key !== key) {
      parallel.current = { vectors, key, segments: parallelSegments(vectors, side) };
    }
    return parallel.current.segments;
  };
  const targetsAt = (chosen: SideSection, point: Point): SideTarget[] => {
    const polygon = outlines[chosen.outlineIndex];
    const side = { start: polygon[chosen.start], end: polygon[chosen.end] };
    const targets = vectorSideTargets(segmentsBeside(side), side, point, 10 / scale);
    if (targets.length) return targets;
    // Sample only the source PDF, never the blue outline or green ROI overlays.
    if (!image.current) {
      try { image.current = source.getContext("2d")?.getImageData(0, 0, source.width, source.height) ?? null; }
      catch { return []; }
    }
    return image.current ? imageSideTargets(image.current, side, point, 10 / scale) : [];
  };
  const choose = (session: FitSession, targetIndex: number): FitSession => {
    const line = session.targets[targetIndex];
    return { ...session, targetIndex, preview: session.section && line
      ? prepareSideFit(outlines, holes, openings, session.section, line, source) : null };
  };
  /** Preview the line under the pointer. While tracking, the previewed line is kept until another is clearly closer. */
  const aim = (session: FitSession, point: Point, sticky: boolean): FitSession => {
    if (!session.section) return session;
    aimedAt.current = point;
    lastAim.current = performance.now();
    const targets = targetsAt(session.section, point);
    const before = session.targets[session.targetIndex];
    const index = stickyTargetIndex(targets, sticky ? before : undefined, point, STICKY_DISTANCE / scale);
    const after = targets[index];
    if (before && after && samePoint(before.start, after.start) && samePoint(before.end, after.end)) {
      return { ...session, targets, targetIndex: index };
    }
    return choose({ ...session, targets }, index);
  };
  const flush = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    const point = pending.current;
    pending.current = null;
    const session = store.current;
    if (!point || session.context !== context || !session.section || session.locked) return;
    update(aim(session, point, true));
    setHint(null);
  };
  /** Throttle aiming, with a trailing update so the preview always catches up with a resting pointer. */
  const track = (point: Point) => {
    pending.current = point;
    if (timer.current !== null) return;
    const wait = AIM_INTERVAL_MS - (performance.now() - lastAim.current);
    if (wait <= 0) flush();
    else timer.current = window.setTimeout(flush, wait);
  };
  const begin = (event: ReactPointerEvent<SVGSVGElement>, point: Point, grabbed: boolean) => {
    stopTracking();
    aimedAt.current = null;
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Synthetic or released pointers cannot be captured. */ }
    drag.current = { pointerId: event.pointerId, element: event.currentTarget, origin: point, grabbed, moved: false };
  };
  /** Abandon an unfinished drag without changing the roof. Also runs after a normal release, when there is none. */
  const abandon = () => {
    const unfinished = endDrag();
    if (!unfinished) return;
    stopTracking();
    const session = live();
    update(unfinished.grabbed ? blank(context) : { ...session, targets: [], targetIndex: 0, preview: null, locked: false });
  };
  const commit = (fit: OutlineEditResult) => {
    update(blank(context));
    setHint(null);
    setGrab(null);
    onCommit(fit);
  };

  const press = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!current || event.button !== 0) return;
    event.preventDefault();
    abandon(); // A release that never arrived must not leave a stale drag behind.
    const session = live();
    const point = position(event);
    setHint(null);
    setGrab(null);
    if (session.section) {
      // With a section chosen, pressing aims at the nearest line and dragging keeps aiming until release.
      begin(event, point, false);
      update(aim({ ...session, locked: false }, point, false));
      return;
    }
    const vertex = findClosestVertex(point.x, point.y, outlines, 10 / scale);
    if (session.first) {
      if (!vertex || vertex.outlineIndex !== session.first.outlineIndex || vertex.vertexIndex === session.first.vertexIndex) {
        setHint("Choose a different end corner on the same outline."); return;
      }
      update({ ...session, first: null, section: { outlineIndex: vertex.outlineIndex,
        ...shorterSide(outlines[vertex.outlineIndex], session.first.vertexIndex, vertex.vertexIndex) } });
    } else if (vertex) {
      update({ ...session, first: { outlineIndex: vertex.outlineIndex, vertexIndex: vertex.vertexIndex } });
    } else {
      const edge = findClosestEdge(point.x, point.y, outlines, 12 / scale);
      if (!edge) { setHint("Press a blue side, or click its two end corners."); return; }
      begin(event, point, true);
      update({ ...session, section: { outlineIndex: edge.outlineIndex, ...suggestSide(outlines[edge.outlineIndex], edge.edgeIndex) } });
    }
  };
  const move = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!current) return;
    const point = position(event);
    const pressed = drag.current;
    if (pressed) {
      if (event.pointerId !== pressed.pointerId) return;
      if (!pressed.moved && Math.hypot(point.x - pressed.origin.x, point.y - pressed.origin.y) * scale >= DRAG_THRESHOLD) {
        pressed.moved = true;
        setVersion(version => version + 1);
      }
      // A grabbed side previews lines only once it is dragged, so a click still just selects it.
      if (pressed.moved || !pressed.grabbed) track(point);
      return;
    }
    const session = live();
    if (session.section) { if (!session.locked) track(point); return; }
    const first = session.first;
    const vertex = findClosestVertex(point.x, point.y, outlines, 10 / scale);
    const edge = vertex || first ? null : findClosestEdge(point.x, point.y, outlines, 12 / scale);
    const corner = vertex && (!first || (vertex.outlineIndex === first.outlineIndex && vertex.vertexIndex !== first.vertexIndex))
      ? { outlineIndex: vertex.outlineIndex, vertexIndex: vertex.vertexIndex } : null;
    const next: Grab | null = corner ? { context, corner }
      : edge ? { context, section: { outlineIndex: edge.outlineIndex, ...suggestSide(outlines[edge.outlineIndex], edge.edgeIndex) } }
      : null;
    if (JSON.stringify(next) !== JSON.stringify(grab)) setGrab(next);
  };
  const release = (event: ReactPointerEvent<SVGSVGElement>) => {
    const pressed = drag.current;
    if (!pressed || event.pointerId !== pressed.pointerId) return;
    const point = position(event);
    const moved = pressed.moved || Math.hypot(point.x - pressed.origin.x, point.y - pressed.origin.y) * scale >= DRAG_THRESHOLD;
    endDrag();
    const session = live();
    if (!moved) {
      stopTracking();
      if (pressed.grabbed) { setVersion(version => version + 1); return; }
      // A click on a line fixes it for review before Apply fit.
      update({ ...session, locked: session.targets.length > 0 });
      setHint(session.targets.length ? null : NO_LINE);
      return;
    }
    // Apply the line under the pointer at release, evaluating it now if the throttled preview has not caught up.
    const aimed = aimedAt.current;
    stopTracking();
    const final = aimed && samePoint(aimed, point) ? session : aim(session, point, true);
    const fit = final.targets[final.targetIndex] ? final.preview : null;
    if (fit && !fit.error) { commit(fit); return; }
    update(pressed.grabbed ? blank(context) : { ...final, targets: [], targetIndex: 0, preview: null, locked: false });
    setHint(`${fit?.error ?? "Released away from a drawing line."} Nothing changed.`);
  };
  const leave = () => {
    if (!current || drag.current) return;
    stopTracking();
    setGrab(null);
    if (current.section && !current.locked && current.targets.length) update({ ...current, targets: [], targetIndex: 0, preview: null });
  };

  const path = section ? pathOf(section) : [];
  const grabPath = hovered && "section" in hovered ? pathOf(hovered.section) : [];
  const grabCorner = hovered && "corner" in hovered ? outlines[hovered.corner.outlineIndex]?.[hovered.corner.vertexIndex] : undefined;
  const points = (ring: Point[]) => ring.map(p => `${p.x},${p.y}`).join(" ");
  const message = hint ?? preview?.error ?? (!current ? ""
    : !section ? current.first ? "Click the other end corner."
      : "Drag a blue side onto a drawing line and release to snap it, or click a side or its two end corners to review first."
    : dragging ? target ? "Release to snap to the highlighted line. Esc cancels." : "Move onto a drawing line running alongside the orange section."
    : current.locked ? "Review the dashed preview, then Apply fit. Click or drag to another line to change the target."
    : "Drag onto a drawing line and release to snap, or click a line to review it first. Orange marks the section being replaced.");

  return {
    active,
    cancel,
    button: enabled ? <Button size="sm" variant="adjustTool" aria-pressed={active}
        title="Drag a roof side onto a line on the plan and release to snap it. Click a side instead to review the fit first."
        onClick={() => {
          if (active) { cancel(); return; }
          onActivate();
          endDrag();
          stopTracking();
          store.current = blank(context);
          setArmed(true);
          setHint(null);
          setGrab(null);
        }}>
        <Magnet className="w-4 h-4 mr-1" />Snap to line
      </Button> : null,
    controls: current ? <>
      {section && <>
        <Button size="sm" variant="ghost" onClick={() => { update(blank(context)); setHint(null); }}>Change section</Button>
        <Button size="sm" variant="ghost" onClick={() => {
          update({ ...current, section: { ...section, start: section.end, end: section.start }, targets: [], targetIndex: 0,
            preview: null, locked: false });
          setHint(null);
        }}>Other path</Button>
        {current.targets.length > 1 && <Button size="sm" variant="outline" onClick={() => {
          update(choose({ ...current, locked: true }, (current.targetIndex + 1) % current.targets.length));
        }}>Next line ({current.targetIndex + 1}/{current.targets.length})</Button>}
        <Button size="sm" disabled={!current.locked || !preview || Boolean(preview.error)} onClick={() => {
          const session = live();
          if (session.locked && session.preview && !session.preview.error) commit(session.preview);
        }}>Apply fit</Button>
      </>}
      <Button size="sm" variant="ghost" title="Leave Snap to line (Esc)" onClick={cancel}>Exit snap</Button>
      <span role="status" className={`text-xs ${preview?.error ? "text-destructive" : "text-muted-foreground"}`}>{message}</span>
    </> : null,
    overlay: current ? <svg viewBox={`0 0 ${source.width} ${source.height}`} width="100%" height="100%"
      data-testid="side-fit-overlay" aria-label="Snap to line: drag a roof side onto a drawing line"
      className={`pointer-events-auto ${dragging ? "cursor-grabbing" : grabPath.length ? "cursor-grab" : "cursor-crosshair"}`}
      style={{ touchAction: "none" }}
      onPointerDown={press} onPointerMove={move} onPointerUp={release} onPointerCancel={abandon}
      onLostPointerCapture={abandon} onPointerLeave={leave}>
      <rect width={source.width} height={source.height} fill="transparent" />
      {grabPath.length > 0 && <polyline points={points(grabPath)} fill="none" stroke="#ea580c" strokeOpacity={0.55} strokeWidth={6}
        strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" data-testid="side-fit-grab" />}
      {grabCorner && <circle cx={grabCorner.x} cy={grabCorner.y} r={7 / scale} fill="none" stroke="#ea580c" strokeWidth={2}
        vectorEffect="non-scaling-stroke" data-testid="side-fit-grab" />}
      {path.length > 0 && <polyline points={points(path)} fill="none" stroke="#c2410c" strokeWidth={4}
        strokeDasharray="6 4" vectorEffect="non-scaling-stroke" data-testid="side-fit-section" />}
      {(current.first ? [outlines[current.first.outlineIndex][current.first.vertexIndex]] : path.length ? [path[0], path[path.length - 1]] : [])
        .map((p, i) => <circle key={i} cx={p.x} cy={p.y} r={5 / scale} fill="white" stroke="#c2410c" strokeWidth={2} vectorEffect="non-scaling-stroke" />)}
      {current.targets.map((line, index) => index !== current.targetIndex && <line key={index} x1={line.start.x} y1={line.start.y}
        x2={line.end.x} y2={line.end.y} stroke="#0f766e" strokeOpacity={0.45} strokeWidth={1.5} strokeDasharray="4 3"
        vectorEffect="non-scaling-stroke" data-testid="side-fit-candidate" />)}
      {target && <line x1={target.start.x} y1={target.start.y} x2={target.end.x} y2={target.end.y}
        stroke={preview?.error ? "#dc2626" : "#0f766e"} strokeWidth={3} vectorEffect="non-scaling-stroke"
        data-testid="side-fit-target" data-source={target.source} />}
      {section && preview && !preview.error && <polygon points={points(preview.outlines[section.outlineIndex])}
        fill="#7c3aed" fillOpacity={0.06} stroke="#7c3aed" strokeWidth={2} strokeDasharray="5 3"
        vectorEffect="non-scaling-stroke" data-testid="side-fit-preview" />}
    </svg> : null,
  };
}
