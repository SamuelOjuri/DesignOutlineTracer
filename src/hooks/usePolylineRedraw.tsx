import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { PenLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Point } from "@/types/roof";
import type { VectorSegment } from "@/types/outline";
import type { OutlineEditResult } from "@/utils/polygonAdjust";
import { findOutlineAnchor, matchRedrawEndpoint, preparePolylineRedraw, redrawRegionIntrusions, redrawSection, snapToVectors,
  REDRAW_VERTEX_MATCH_TOLERANCE, type OutlineAnchor, type RedrawRegion, type VectorSnap } from "@/utils/polylineRedraw";

interface RedrawSession {
  context: string;
  start: OutlineAnchor | null;
  via: Point[];
  end: OutlineAnchor | null;
  otherPath: boolean;
  finishing: boolean;
}

interface Cursor {
  context: string;
  point: Point;
  anchor: OutlineAnchor | null;
  snap: VectorSnap | null;
  completion: OutlineAnchor | null;
}

interface RedrawPress {
  pointerId: number;
  element: SVGSVGElement;
  context: string;
  origin: Point;
  moved: boolean;
}

interface PolylineRedrawOptions {
  enabled: boolean;
  outlines: Point[][];
  holes: Point[][];
  openings: Point[][];
  vectors: readonly VectorSegment[];
  source: HTMLCanvasElement;
  scale: number;
  onCommit: (edit: OutlineEditResult) => void;
  onActivate: () => void;
  /** While set, drafting continues but nothing is applied; the text explains what to finish first. */
  commitBlocked?: string | null;
  /** Accepted roof areas still without an outline. Adding area inside one is flagged before applying. */
  pendingRegions?: readonly RedrawRegion[];
}

const blank = (context: string): RedrawSession => ({ context, start: null, via: [], end: null, otherPath: false, finishing: false });
const distance = (first: Point, second: Point) => Math.hypot(first.x - second.x, first.y - second.y);
const points = (ring: Point[]) => ring.map(point => `${point.x},${point.y}`).join(" ");
const listLabels = (labels: string[]) => labels.length < 2 ? labels.join("")
  : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
const intrusionWarning = (regions: readonly RedrawRegion[]) => !regions.length ? "" : regions.length === 1
  ? `This redraw extends into ${regions[0].label}, which has not been outlined yet; its generated outline could then be rejected as overlapping.`
  : `This redraw extends into ${listLabels(regions.map(region => region.label))}, which have not been outlined yet; their generated outlines could then be rejected as overlapping.`;
const CLICK_TRAVEL = 4;
const ANCHOR_RADIUS = 6;
const VECTOR_RADIUS = 10;

function finishAt(session: RedrawSession, end: OutlineAnchor): RedrawSession {
  const last = session.via[session.via.length - 1];
  const via = last && distance(last, end.point) <= REDRAW_VERTEX_MATCH_TOLERANCE ? session.via.slice(0, -1) : session.via;
  return { ...session, via, end };
}

/** Replace a boundary path on explicit Apply or a deliberate click on a matching PDF endpoint. */
export function usePolylineRedraw({ enabled, outlines, holes, openings, vectors, source, scale,
  onCommit, onActivate, commitBlocked = null, pendingRegions = [] }: PolylineRedrawOptions) {
  const context = JSON.stringify([outlines, holes, openings]);
  const [armed, setArmed] = useState(false);
  const [hint, setHint] = useState<{ context: string; text: string } | null>(null);
  const [cursor, setCursor] = useState<Cursor | null>(null);
  const [, setVersion] = useState(0);
  const store = useRef<RedrawSession>(blank(context));
  const press = useRef<RedrawPress | null>(null);
  const backAction = useRef<() => void>(() => {});

  const endPress = useCallback(() => {
    const pending = press.current;
    press.current = null;
    if (pending?.element.hasPointerCapture?.(pending.pointerId)) pending.element.releasePointerCapture(pending.pointerId);
    return pending;
  }, []);
  const cancel = useCallback(() => {
    endPress();
    store.current = blank(store.current.context);
    setArmed(false);
    setHint(null);
    setCursor(null);
  }, [endPress]);

  useEffect(() => { cancel(); }, [enabled, source, cancel]);
  const active = enabled && armed;
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { cancel(); return; }
      if (!active || event.key !== "Backspace") return;
      const target = event.target;
      if (target instanceof HTMLElement && target.closest("input, textarea, select, button, [contenteditable=true]")) return;
      event.preventDefault();
      backAction.current();
    };
    window.addEventListener("keydown", key);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("blur", cancel);
      endPress();
    };
  }, [active, cancel, endPress]);

  // Undo and external geometry edits invalidate the draft without turning the tool off.
  const live = (): RedrawSession => store.current.context === context ? store.current : blank(context);
  const current = active ? live() : null;
  const update = (session: RedrawSession) => { store.current = session; setVersion(version => version + 1); };
  const tell = (text: string) => setHint({ context, text });
  const safeScale = Math.max(0.0001, scale);
  const position = (event: ReactPointerEvent<SVGSVGElement>): Point => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: (event.clientX - bounds.left) * source.width / bounds.width,
      y: (event.clientY - bounds.top) * source.height / bounds.height };
  };
  const aim = (point: Point, free: boolean, session: RedrawSession): Cursor => {
    // Only an endpoint matching a real vertex can shortcut manual reconnection. Nearby returns stay draft points.
    const anchoring = !session.start || session.finishing;
    const anchor = anchoring ? findOutlineAnchor(point, outlines, ANCHOR_RADIUS / safeScale, !free) : null;
    if (anchor) return { context, point: anchor.point, anchor, snap: null, completion: null };
    const snap = free || anchoring ? null : snapToVectors(point, vectors, VECTOR_RADIUS / safeScale);
    const completion = !free && !anchoring && session.start ? matchRedrawEndpoint(snap, outlines, session.start) : null;
    return { context, point: completion?.point ?? snap?.point ?? point, anchor: null, snap, completion };
  };
  const evaluate = (session: RedrawSession): OutlineEditResult | null => session.start && session.end
    ? preparePolylineRedraw(outlines, holes, openings, session.start, session.end, session.via, session.otherPath, source) : null;
  const intrusionsFor = (session: RedrawSession, edit: OutlineEditResult | null): RedrawRegion[] => {
    const index = session.start?.outlineIndex;
    if (index === undefined || !edit || edit.error || !pendingRegions.length) return [];
    return redrawRegionIntrusions(outlines[index], edit.outlines[index], pendingRegions);
  };
  const back = () => {
    const session = live();
    setHint(null);
    setCursor(null);
    if (session.end) update({ ...session, end: null, otherPath: false, finishing: false });
    else if (session.via.length) update({ ...session, via: session.via.slice(0, -1), finishing: false });
    else update(blank(context));
  };
  backAction.current = back;
  const commit = (edit: OutlineEditResult) => {
    update(blank(context));
    setHint(null);
    setCursor(null);
    onCommit(edit);
  };
  const apply = () => {
    if (commitBlocked) { tell(commitBlocked); return; }
    const edit = evaluate(live());
    if (edit && !edit.error) commit(edit);
  };

  const add = (point: Point, free: boolean) => {
    const session = live();
    if (session.end) { tell("Review the dashed preview, or use Back to change the last point."); return; }
    const target = aim(point, free, session);
    setCursor(target);
    setHint(null);
    if (!session.start) {
      if (!target.anchor) { tell("Click a blue outline edge or corner to start."); return; }
      update({ ...session, start: target.anchor });
      return;
    }
    if (session.finishing) {
      if (!target.anchor) { tell("Click the same blue outline to reconnect, or choose Keep drawing."); return; }
      if (target.anchor.outlineIndex !== session.start.outlineIndex) {
        tell("Reconnect to the same roof outline where you started."); return;
      }
      if (distance(target.anchor.point, session.start.point) < 1e-6) {
        tell("Choose a different point on the outline to finish."); return;
      }
      update(finishAt(session, target.anchor));
      setCursor(null);
      return;
    }
    if (target.completion) {
      const finished = finishAt(session, target.completion);
      const edit = evaluate(finished);
      if (!edit || edit.error) {
        tell(edit?.error ?? "The redraw could not be completed. Keep drawing or choose Finish on outline.");
        return;
      }
      if (commitBlocked || intrusionsFor(finished, edit).length) {
        // A one-click finish never applies past a guard; keep it ready for an explicit Apply redraw.
        update(finished);
        setCursor(null);
        return;
      }
      commit(edit);
      return;
    }
    const previous = session.via[session.via.length - 1] ?? session.start.point;
    if (distance(previous, target.point) < 1e-6) { tell("Choose a different position for the next corner."); return; }
    if (target.point.x < 0 || target.point.y < 0 || target.point.x > source.width || target.point.y > source.height) {
      tell("Place the corner inside the drawing page."); return;
    }
    update({ ...session, via: [...session.via, target.point] });
  };
  const down = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!current || event.button !== 0) return;
    event.preventDefault();
    endPress();
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Unsupported synthetic capture. */ }
    press.current = { pointerId: event.pointerId, element: event.currentTarget, context, origin: position(event), moved: false };
  };
  const move = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!current || current.end) return;
    const point = position(event);
    const pending = press.current;
    if (pending && pending.pointerId !== event.pointerId) return;
    if (pending && distance(point, pending.origin) * safeScale >= CLICK_TRAVEL) pending.moved = true;
    setHint(null);
    setCursor(aim(point, event.altKey, live()));
  };
  const up = (event: ReactPointerEvent<SVGSVGElement>) => {
    const pending = press.current;
    if (!current || !pending || pending.pointerId !== event.pointerId) return;
    const point = position(event);
    endPress();
    if (pending.context !== context) return;
    if (pending.moved || distance(point, pending.origin) * safeScale >= CLICK_TRAVEL) {
      tell("Click to place each corner. Dragging does not change the redraw."); return;
    }
    add(point, event.altKey);
  };
  const abandon = () => { endPress(); setCursor(null); };

  const hovered = current && cursor?.context === context && !current.end ? cursor : null;
  const review = current && hovered?.completion ? finishAt(current, hovered.completion) : current;
  const preview = review ? evaluate(review) : null;
  const valid = Boolean(preview && !preview.error);
  const removed = review?.start && review.end ? redrawSection(outlines, review.start, review.end, review.otherPath) : [];
  const draft = current?.start ? [current.start.point, ...current.via, ...(current.end ? [current.end.point] : [])] : [];
  const rubber = draft.length && !current?.end && hovered ? [draft[draft.length - 1], hovered.point] : [];
  const intrusions = review ? intrusionsFor(review, preview) : [];
  const ready = valid && Boolean(review?.end);
  // Guards apply only to a valid finished redraw; drafting itself is never restricted.
  const notice = ready ? [commitBlocked, intrusionWarning(intrusions)].filter(Boolean).join(" ") : "";
  const held = ready && Boolean(commitBlocked || intrusions.length);
  const label = hovered?.completion ? valid ? held ? "Click to finish for review" : "Click to finish and apply" : "Cannot finish here"
    : hovered?.anchor ? current?.start ? "Finish on outline" : "Start on outline"
    : hovered?.snap ? `PDF ${hovered.snap.kind}` : "Free point";
  const guidance = !current ? ""
    : current.end ? commitBlocked
      ? "Review the dashed outline and orange section; Apply redraw becomes available afterwards. Other path changes the section replaced."
      : "Review the dashed outline and orange section, then Apply redraw. Other path changes the section replaced."
    : hovered?.completion ? held
      ? "Click to finish, then review before applying. Hold Alt to continue drawing, or use Other path to change the section."
      : "Click to finish and apply. Review the orange section and dashed outline. Hold Alt to continue drawing, or use Other path to change the section."
    : current.finishing ? "Click the same blue outline where the redraw should reconnect. Hold Alt to connect along an edge near an existing corner. Keep drawing returns to placing corners."
    : current.start ? "Click each new corner. Click a matching PDF endpoint to finish and apply, or choose Finish on outline to review first. Hold Alt for a free point; Backspace removes the last point."
    : "Click a blue outline edge or corner to start, then trace the missing boundary. Hold Alt to start along an edge near an existing corner.";
  const message = hint?.context === context ? hint.text : preview?.error ?? [notice, guidance].filter(Boolean).join(" ");
  const tone = preview?.error ? "text-destructive" : notice ? "text-amber-700" : "text-muted-foreground";
  const noVectors = !vectors.length ? " No PDF vector lines are available; place corners manually." : "";

  return {
    active,
    cancel,
    button: enabled ? <Button size="sm" variant="adjustTool" aria-pressed={active}
      title="Trace new corners with PDF snapping. Click a matching outline vertex to finish and apply, or use Finish on outline to review first."
      onClick={() => {
        if (active) { cancel(); return; }
        onActivate();
        endPress();
        store.current = blank(context);
        setArmed(true);
        setHint(null);
        setCursor(null);
      }}><PenLine className="w-4 h-4 mr-1" />Redraw</Button> : null,
    controls: current ? <>
      {current.start && <>
        <Button size="sm" variant="ghost" onClick={back} title="Remove the last redraw point (Backspace)">Back</Button>
        <Button size="sm" variant="ghost" onClick={() => { update(blank(context)); setHint(null); setCursor(null); }}>Clear</Button>
        <Button size="sm" variant="ghost" title="Switch which path around the outline is replaced" onClick={() => {
          update({ ...live(), otherPath: !live().otherPath }); setHint(null);
        }}>Other path</Button>
      </>}
      {current.start && !current.end && <Button size="sm" variant="outline"
        title="Connect to an existing outline edge or corner; hold Alt to connect along an edge near a corner."
        onClick={() => {
        update({ ...live(), finishing: !live().finishing }); setHint(null); setCursor(null);
      }}>{current.finishing ? "Keep drawing" : "Finish on outline"}</Button>}
      {current.end && <>
        <Button size="sm" disabled={!valid || Boolean(commitBlocked)} title={commitBlocked ?? undefined} onClick={apply}>Apply redraw</Button>
      </>}
      <Button size="sm" variant="ghost" title="Leave Redraw (Esc)" onClick={cancel}>Exit redraw</Button>
      <span role="status" className={`text-xs ${tone}`}>{message}{noVectors}</span>
    </> : null,
    overlay: current ? <svg viewBox={`0 0 ${source.width} ${source.height}`} width="100%" height="100%"
      data-testid="polyline-redraw-overlay" aria-label="Redraw outline: click the boundary, add corners, then choose Finish on outline"
      className="pointer-events-auto cursor-crosshair" style={{ touchAction: "none" }}
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={abandon}
      onLostPointerCapture={abandon} onPointerLeave={() => { if (!press.current && !hovered?.completion) setCursor(null); }}>
      <rect width={source.width} height={source.height} fill="transparent" />
      {removed.length > 0 && <polyline points={points(removed)} fill="none" stroke="#c2410c" strokeWidth={4}
        strokeDasharray="6 4" vectorEffect="non-scaling-stroke" data-testid="polyline-redraw-section" />}
      {preview && valid && current.start && <polygon points={points(preview.outlines[current.start.outlineIndex])}
        fill="#7c3aed" fillOpacity={0.06} stroke="#7c3aed" strokeWidth={2} strokeDasharray="5 3"
        vectorEffect="non-scaling-stroke" data-testid="polyline-redraw-preview" />}
      {hovered?.snap?.segments.map((segment, index) => <line key={index} x1={segment.start.x} y1={segment.start.y}
        x2={segment.end.x} y2={segment.end.y} stroke="#0f766e" strokeOpacity={0.7} strokeWidth={2}
        vectorEffect="non-scaling-stroke" data-testid="polyline-redraw-vector" />)}
      {draft.length > 1 && <polyline points={points(draft)} fill="none" stroke={preview?.error ? "#dc2626" : "#7c3aed"}
        strokeWidth={2} vectorEffect="non-scaling-stroke" data-testid="polyline-redraw-draft" />}
      {rubber.length > 0 && <polyline points={points(rubber)} fill="none" stroke={preview?.error ? "#dc2626" : "#7c3aed"} strokeWidth={1.5}
        strokeDasharray="4 3" vectorEffect="non-scaling-stroke" data-testid="polyline-redraw-rubber" />}
      {draft.map((point, index) => <circle key={index} cx={point.x} cy={point.y} r={4 / safeScale}
        fill="white" stroke={index === 0 || current.end && index === draft.length - 1 ? "#c2410c" : "#7c3aed"}
        strokeWidth={2} vectorEffect="non-scaling-stroke" data-testid="polyline-redraw-point" />)}
      {hovered && <>
        <circle cx={hovered.point.x} cy={hovered.point.y} r={6 / safeScale} fill="white"
          stroke={hovered.completion ? valid ? held ? "#b45309" : "#15803d" : "#dc2626" : hovered.anchor ? "#15803d" : hovered.snap ? "#0f766e" : "#7c3aed"} strokeWidth={2}
          vectorEffect="non-scaling-stroke" data-testid="polyline-redraw-cursor" data-snap={hovered.completion ? "finish" : hovered.anchor ? "outline" : hovered.snap?.kind ?? "free"} />
        <text x={hovered.point.x + 10 / safeScale} y={hovered.point.y - 10 / safeScale} fontSize={12 / safeScale}
          fill="#134e4a" stroke="white" strokeWidth={3 / safeScale} paintOrder="stroke" fontWeight={600}>{label}</text>
      </>}
    </svg> : null,
  };
}
