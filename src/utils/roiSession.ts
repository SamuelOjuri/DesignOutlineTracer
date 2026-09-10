import type { DrawingScale } from "@/types/roof";
import type { AnnotationKind, Box2D, DetectionRequest, DetectionRun, PageDrawing, PageSession, RenderedPdfPage, RoiAnnotation, RoiSessionState } from "@/types/roi";
import { validateBox } from "./roiCoordinates";

export const initialRoiState: RoiSessionState = { active_page_id: null, pages: {} };

type ReviewPatch = Partial<Pick<RoiAnnotation, "box_2d" | "label" | "subtype" | "roi_id" | "review_status" | "validity">>;
export type RoiSessionAction =
  | { type: "activate"; source: RenderedPdfPage; scale: DrawingScale }
  | { type: "select"; page_id: string | null }
  | { type: "drawing"; page_id: string; drawing: PageDrawing }
  | { type: "add"; page_id: string; annotation: RoiAnnotation }
  | { type: "review"; page_id: string; id: string; patch: ReviewPatch }
  | { type: "remove"; page_id: string; id: string }
  | { type: "undo"; page_id: string }
  | { type: "start"; request: DetectionRequest }
  | { type: "result"; run: DetectionRun; annotations: RoiAnnotation[] }
  | { type: "cancel"; page_id: string; task: AnnotationKind; request_id: string };

export function emptyDrawing(scale: DrawingScale): PageDrawing {
  return { outlines: [], holes: [], outlets: [], drainage_edges: [], drawing_scale: { ...scale } };
}

function cloneAnnotation(annotation: RoiAnnotation): RoiAnnotation {
  validateBox(annotation.box_2d);
  validateBox(annotation.proposed_box_2d);
  return { ...annotation, box_2d: [...annotation.box_2d], proposed_box_2d: [...annotation.proposed_box_2d],
    edits: annotation.edits.map((edit) => ({ ...edit })), warnings: [...annotation.warnings] };
}

function cloneDrawing(drawing: PageDrawing): PageDrawing {
  return { ...drawing, drawing_scale: { ...drawing.drawing_scale },
    outlines: drawing.outlines.map((polygon) => ({ ...polygon, points: polygon.points.map((point) => ({ ...point })) })),
    holes: drawing.holes.map((polygon) => ({ ...polygon, points: polygon.points.map((point) => ({ ...point })) })),
    outlets: drawing.outlets.map((outlet) => ({ ...outlet })),
    drainage_edges: drawing.drainage_edges.map((edge) => ({ ...edge })) };
}

function acceptedParent(annotation: RoiAnnotation): boolean {
  return annotation.kind === "roof_roi" && annotation.review_status === "accepted" && annotation.validity === "current";
}

function checkAssociation(annotation: RoiAnnotation, annotations: RoiAnnotation[]): RoiAnnotation {
  if (annotation.kind === "roof_roi") return { ...annotation, roi_id: null };
  const parent = annotations.find((candidate) => candidate.id === annotation.roi_id && acceptedParent(candidate));
  return parent ? annotation : { ...annotation, validity: "needs_review" };
}

function parentChanges(before: RoiAnnotation[], after: RoiAnnotation[]): Set<string> {
  const signature = (annotation?: RoiAnnotation) => annotation && acceptedParent(annotation)
    ? JSON.stringify([annotation.box_2d, annotation.label, annotation.revision]) : null;
  const ids = new Set([...before, ...after].filter((annotation) => annotation.kind === "roof_roi").map((annotation) => annotation.id));
  return new Set([...ids].filter((id) => signature(before.find((annotation) => annotation.id === id))
    !== signature(after.find((annotation) => annotation.id === id))));
}

function invalidateChildren(page: PageSession, parents?: Set<string>): PageSession {
  const pending = { ...page.pending };
  delete pending.penetration;
  delete pending.rainwater_outlet;
  return { ...page, pending, annotations: page.annotations.map((annotation) => {
    if (annotation.kind === "roof_roi" || (parents && !parents.has(annotation.roi_id ?? ""))) return annotation;
    return { ...annotation, validity: "needs_review", revision: page.revision,
      edits: [...annotation.edits, { revision: page.revision, action: "invalidate" }] };
  }) };
}

function storePage(state: RoiSessionState, page: PageSession): RoiSessionState {
  return { ...state, pages: { ...state.pages, [page.source.page_id]: page } };
}

function selectPage(state: RoiSessionState, pageId: string | null): RoiSessionState {
  if (pageId === state.active_page_id) return state;
  const oldPage = state.active_page_id ? state.pages[state.active_page_id] : null;
  return { ...(oldPage ? storePage(state, { ...oldPage, pending: {} }) : state), active_page_id: pageId };
}

function matchesRequest(page: PageSession, request: DetectionRequest): boolean {
  return request.source_image_hash === page.source.source_image_hash
    && (request.task === "roof_roi" ? request.roi_revision === null
      : request.roi_revision === page.roi_revision && request.geometry_revision === page.geometry_revision);
}

function boxArea(box: Box2D): number {
  return (box[2] - box[0]) * (box[3] - box[1]);
}

function similarBoxes(first: Box2D, second: Box2D): boolean {
  const intersection = Math.max(0, Math.min(first[2], second[2]) - Math.max(first[0], second[0]))
    * Math.max(0, Math.min(first[3], second[3]) - Math.max(first[1], second[1]));
  return intersection / (boxArea(first) + boxArea(second) - intersection) >= 0.8;
}

export function roiSessionReducer(state: RoiSessionState, action: RoiSessionAction): RoiSessionState {
  if (action.type === "select") {
    return action.page_id === null || state.pages[action.page_id] ? selectPage(state, action.page_id) : state;
  }
  if (action.type === "activate") {
    const pageId = action.source.page_id;
    const existing = state.pages[pageId];
    if (existing && existing.source.source_image_hash !== action.source.source_image_hash) throw new Error("Page identity mismatch");
    const next = existing ? state : storePage(state, { source: action.source, annotations: [], roi_revision: 0,
      geometry_revision: 0, revision: 0, pending: {}, used_request_ids: [], runs: [], history: [], drawing: emptyDrawing(action.scale) });
    return selectPage(next, pageId);
  }
  const pageId = action.type === "start" ? action.request.page_id : action.type === "result" ? action.run.page_id : action.page_id;
  const page = state.pages[pageId];
  if (!page) return state;

  if (action.type === "start") {
    const request = action.request;
    if (pageId !== state.active_page_id || !matchesRequest(page, request) || page.used_request_ids.includes(request.request_id)) return state;
    if (request.task !== "roof_roi" && !page.annotations.some(acceptedParent)) return state;
    return storePage(state, { ...page, pending: { ...page.pending, [request.task]: { ...request } },
      used_request_ids: [...page.used_request_ids, request.request_id] });
  }
  if (action.type === "cancel") {
    if (page.pending[action.task]?.request_id !== action.request_id) return state;
    const pending = { ...page.pending };
    delete pending[action.task];
    return storePage(state, { ...page, pending });
  }
  if (action.type === "result") {
    const { run } = action;
    const pendingRequest = page.pending[run.task];
    if (pageId !== state.active_page_id || !pendingRequest || !matchesRequest(page, run)
      || pendingRequest.request_id !== run.request_id || pendingRequest.roi_revision !== run.roi_revision
      || pendingRequest.geometry_revision !== run.geometry_revision) return state;
    if (action.annotations.some((annotation) => annotation.page_id !== pageId || annotation.kind !== run.task)) return state;
    const pending = { ...page.pending };
    delete pending[run.task];
    const annotations = [...page.annotations];
    for (const candidate of action.annotations) {
      if (annotations.some((annotation) => annotation.id === candidate.id)) continue;
      const duplicate = annotations.some((annotation) => annotation.kind === candidate.kind
        && annotation.roi_id === candidate.roi_id && (similarBoxes(annotation.box_2d, candidate.box_2d)
          || similarBoxes(annotation.proposed_box_2d, candidate.box_2d)));
      const proposal = checkAssociation({ ...cloneAnnotation(candidate), origin: "gemini", review_status: "suggested",
        proposed_box_2d: [...candidate.box_2d], edits: [], revision: page.revision + 1 }, annotations);
      if (duplicate) proposal.warnings.push("Possible duplicate; reconcile with existing annotation");
      if (candidate.kind === "roof_roi" && boxArea(candidate.box_2d) >= 850000) {
        proposal.warnings.push("Covers most of the sheet; verify the intended roof scope");
      }
      annotations.push(proposal);
    }
    return storePage(state, { ...page, pending, annotations, revision: page.revision + 1,
      runs: [...page.runs, { ...run, settings: { ...run.settings }, warnings: [...run.warnings] }] });
  }
  if (action.type === "drawing") {
    if ([...action.drawing.outlines, ...action.drawing.holes, ...action.drawing.outlets].some((record) => record.page_id !== pageId)) {
      throw new Error("Drawing belongs to another page");
    }
    const changed = JSON.stringify([page.drawing.outlines, page.drawing.holes]) !== JSON.stringify([action.drawing.outlines, action.drawing.holes]);
    const next = { ...page, drawing: cloneDrawing(action.drawing), revision: page.revision + 1,
      geometry_revision: page.geometry_revision + (changed ? 1 : 0) };
    return storePage(state, changed ? invalidateChildren(next) : next);
  }

  let annotations = [...page.annotations];
  const history = [...page.history];
  const revision = page.revision + 1;
  if (action.type === "undo") {
    const entry = history.pop();
    if (!entry) return state;
    const current = annotations.find((annotation) => annotation.id === entry.id);
    annotations = annotations.filter((annotation) => annotation.id !== entry.id);
    if (entry.before) {
      const staleChild = entry.before.kind !== "roof_roi"
        && (entry.roi_revision !== page.roi_revision || entry.geometry_revision !== page.geometry_revision);
      const restored = checkAssociation({ ...cloneAnnotation(entry.before), revision,
        validity: staleChild || current?.validity === "needs_review" ? "needs_review" : entry.before.validity,
        edits: [...(current?.edits ?? entry.before.edits), { revision, action: "undo" }] }, annotations);
      annotations.splice(Math.min(entry.index, annotations.length), 0, restored);
    }
  } else if (action.type === "add") {
    if (action.annotation.page_id !== pageId || annotations.some((annotation) => annotation.id === action.annotation.id)) return state;
    const annotation = checkAssociation({ ...cloneAnnotation(action.annotation), revision }, annotations);
    annotations.push(annotation);
    history.push({ id: annotation.id, index: annotations.length - 1, before: null, roi_revision: page.roi_revision, geometry_revision: page.geometry_revision });
  } else {
    const current = annotations.find((annotation) => annotation.id === action.id);
    if (!current) return state;
    history.push({ id: current.id, index: annotations.indexOf(current), before: cloneAnnotation(current), roi_revision: page.roi_revision, geometry_revision: page.geometry_revision });
    if (action.type === "remove") annotations = annotations.filter((annotation) => annotation.id !== action.id);
    else {
      const updated = checkAssociation(cloneAnnotation({ ...current, ...action.patch, revision,
        edits: [...current.edits, { revision, action: action.patch.box_2d ? "edit" : "review" }] }), annotations);
      annotations = annotations.map((annotation) => annotation.id === current.id ? updated : annotation);
    }
  }
  const parents = parentChanges(page.annotations, annotations);
  const next = { ...page, annotations, history: history.slice(-100), revision, roi_revision: page.roi_revision + (parents.size ? 1 : 0) };
  return storePage(state, parents.size ? invalidateChildren(next, parents) : next);
}