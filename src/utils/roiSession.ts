import type { DrawingScale, Point } from "@/types/roof";
import type { AnnotationKind, Box2D, DetectionRequest, DetectionRun, PageDrawing, PageSession, RenderedPdfPage, RoiAnnotation, RoiSessionState } from "@/types/roi";
import { validateBox } from "./roiCoordinates";
import { penetrationAssociationWarnings } from "./penetrationAssociation";
import { penetrationFootprint } from "./penetrationOpenings";
import type { OutlineResponse } from "@/types/outline";
import { cloneOutlineDrawing, prepareOutlineApplication } from "./outlineSession";
import { outletAssociation, outletScopeSignature, sameOutletSymbol } from "./outletScope";

export const initialRoiState: RoiSessionState = { active_page_id: null, pages: {} };

type ReviewPatch = Partial<Pick<RoiAnnotation, "box_2d" | "label" | "subtype" | "roi_id" | "review_status" | "validity">>;
export type OutletReviewPatch = Partial<Pick<RoiAnnotation, "label" | "subtype" | "roi_id" | "outline_id" | "review_status"
  | "anchor" | "diameter" | "diameter_confirmed">>;
export type RoiSessionAction =
  | { type: "outlet-result"; page_id: string; request_id: string; scope_signature: string; annotations: RoiAnnotation[] }
  | { type: "outlet-review"; page_id: string; id: string; patch: OutletReviewPatch }
  | { type: "outlet-move"; page_id: string; id: string; anchor: Point }
  | { type: "outlet-delete"; page_id: string; id: string }
  | { type: "outlet-undo"; page_id: string }
  | { type: "activate"; source: RenderedPdfPage; scale: DrawingScale }
  | { type: "select"; page_id: string | null }
  | { type: "drawing"; page_id: string; drawing: PageDrawing }
  | { type: "apply_outline"; page_id: string; result: OutlineResponse; replace_outline_ids: string[] }
  | { type: "undo_outline"; page_id: string }
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
    ...(annotation.anchor ? { anchor: { ...annotation.anchor } } : {}),
    ...(annotation.proposed_anchor ? { proposed_anchor: { ...annotation.proposed_anchor } } : {}),
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
  const previous = state.pages[page.source.page_id];
  if (previous && outletScopeSignature(previous) !== outletScopeSignature(page)) {
    const pending = { ...page.pending };
    delete pending.rainwater_outlet;
    page = { ...page, pending, outlet_scope_revision: (previous.outlet_scope_revision ?? 0) + 1,
      annotations: page.annotations.map(annotation => annotation.kind === "rainwater_outlet" && annotation.anchor
        && !annotation.deleted && annotation.review_status !== "rejected"
        ? { ...annotation, validity: "needs_review", revision: page.revision,
          edits: [...annotation.edits, { revision: page.revision, action: "invalidate" }] } : annotation) };
  }
  return { ...state, pages: { ...state.pages, [page.source.page_id]: page } };
}

function selectPage(state: RoiSessionState, pageId: string | null): RoiSessionState {
  if (pageId === state.active_page_id) return state;
  const oldPage = state.active_page_id ? state.pages[state.active_page_id] : null;
  return { ...(oldPage ? storePage(state, { ...oldPage, pending: {} }) : state), active_page_id: pageId };
}

function matchesRequest(page: PageSession, request: DetectionRequest): boolean {
  return request.source_image_hash === page.source.source_image_hash
    && (!request.scope_signature || request.scope_signature === outletScopeSignature(page))
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

  if (action.type === "outlet-result") {
    const pendingRequest = page.pending.rainwater_outlet;
    if (pageId !== state.active_page_id || !pendingRequest || pendingRequest.request_id !== action.request_id
      || action.scope_signature !== outletScopeSignature(page) || pendingRequest.scope_signature !== action.scope_signature
      || action.annotations.some(annotation => annotation.page_id !== pageId || annotation.kind !== "rainwater_outlet")) return state;
    const annotations = [...page.annotations];
    for (const candidate of action.annotations) {
      if (!candidate.anchor || !Number.isFinite(candidate.anchor.x) || !Number.isFinite(candidate.anchor.y)
        || annotations.some(annotation => annotation.id === candidate.id || (annotation.kind === "rainwater_outlet"
          && sameOutletSymbol(page, annotation, candidate)))) continue;
      // Existing manually placed points also take precedence over a new machine suggestion.
      if (page.drawing.outlets.some(outlet => Math.hypot(outlet.x - candidate.anchor!.x, outlet.y - candidate.anchor!.y) <= 2
        && (!outlet.outline_id || outlet.outline_id === candidate.outline_id))) continue;
      const proposal: RoiAnnotation = { ...cloneAnnotation(candidate), review_status: "suggested", origin: "gemini",
        editor_object_id: `outlet:${candidate.id}`, scope_signature: action.scope_signature,
        diameter: 0.15, diameter_confirmed: false, revision: page.revision + 1, edits: [], deleted: false,
        proposed_anchor: { ...candidate.anchor } };
      const association = outletAssociation(page, proposal);
      if (association.error || association.warnings.length) proposal.validity = "needs_review";
      proposal.warnings = [...new Set([...proposal.warnings, ...association.warnings])];
      annotations.push(proposal);
    }
    const pending = { ...page.pending };
    delete pending.rainwater_outlet;
    return storePage(state, { ...page, pending, annotations, revision: page.revision + 1 });
  }

  if (action.type === "outlet-review" || action.type === "outlet-move" || action.type === "outlet-delete" || action.type === "outlet-undo") {
    if (pageId !== state.active_page_id) return state;
    const history = [...(page.outlet_history ?? [])];
    if (action.type === "outlet-undo") {
      const snapshot = history.pop();
      if (!snapshot) return state;
      const stale = snapshot.scope_signature !== outletScopeSignature(page);
      // Preserve suggestions received after this user edit; restore only the reviewed state.
      const restoredIds = new Set(snapshot.annotations.map(annotation => annotation.id));
      const restored = snapshot.annotations.map(annotation => ({ ...cloneAnnotation(annotation), revision: page.revision + 1,
        validity: stale ? "needs_review" as const : annotation.validity }));
      return storePage(state, { ...page, revision: page.revision + 1, outlet_history: history,
        annotations: [...page.annotations.filter(annotation => annotation.kind !== "rainwater_outlet" || !restoredIds.has(annotation.id)), ...restored] });
    }
    const current = page.annotations.find(annotation => annotation.kind === "rainwater_outlet"
      && (annotation.id === action.id || annotation.editor_object_id === action.id || `outlet:${annotation.id}` === action.id));
    if (!current || current.deleted) return state;
    const patch = action.type === "outlet-review" ? action.patch : action.type === "outlet-move" ? { anchor: action.anchor } : {};
    if (patch.anchor && (!Number.isFinite(patch.anchor.x) || !Number.isFinite(patch.anchor.y)
      || patch.anchor.x < 0 || patch.anchor.y < 0 || patch.anchor.x > page.source.source_width || patch.anchor.y > page.source.source_height)) return state;
    if (patch.diameter !== undefined && (!Number.isFinite(patch.diameter) || patch.diameter < 0.01 || patch.diameter > 2)) return state;
    const revision = page.revision + 1;
    const updated: RoiAnnotation = { ...cloneAnnotation(current), ...patch, revision,
      edits: [...current.edits, { revision, action: patch.anchor ? "edit" : "review" }] };
    if (action.type === "outlet-delete") {
      updated.deleted = true;
      updated.review_status = "rejected";
    } else {
      const association = outletAssociation(page, updated);
      if (patch.anchor || patch.roi_id !== undefined || patch.outline_id !== undefined || patch.review_status === "accepted") {
        const geometricWarnings = new Set(["outlet_outside_scope", "outlet_in_opening", "candidate_outside_scope"]);
        updated.warnings = updated.warnings.filter(warning => !geometricWarnings.has(warning)
          && !warning.startsWith("The inlet is") && !warning.startsWith("Choose an insulation outline")
          && !warning.startsWith("An accepted or manual outlet already occupies")
          && !warning.startsWith("Choose an accepted current roof area") && !warning.startsWith("This position overlaps"));
        updated.warnings = [...new Set([...updated.warnings, ...association.warnings])];
      }
      const accepting = patch.review_status === "accepted";
      if (accepting && association.error) return state;
      const associationEdited = patch.roi_id !== undefined || patch.outline_id !== undefined || patch.subtype !== undefined;
      if (accepting || (patch.anchor && current.review_status === "accepted" && current.validity === "current" && !associationEdited)) {
        updated.validity = association.error ? "needs_review" : "current";
        if (!association.error) updated.scope_signature = outletScopeSignature(page);
      } else if (associationEdited || association.error) updated.validity = "needs_review";
    }
    history.push({ annotations: page.annotations.filter(annotation => annotation.kind === "rainwater_outlet").map(cloneAnnotation),
      outlets: page.drawing.outlets.map(outlet => ({ ...outlet })), scope_signature: outletScopeSignature(page) });
    return storePage(state, { ...page, revision, outlet_history: history.slice(-100),
      annotations: page.annotations.map(annotation => annotation.id === current.id ? updated : annotation) });
  }

  if (action.type === "apply_outline") {
    if (pageId !== state.active_page_id) return state;
    const prepared = prepareOutlineApplication(page, action.result, action.replace_outline_ids);
    if (!prepared.drawing || prepared.error) return state;
    const revision = page.revision + 1;
    return storePage(state, invalidateChildren({ ...page, drawing: prepared.drawing, revision,
      geometry_revision: page.geometry_revision + 1,
      outline_undo: { drawing: cloneOutlineDrawing(page.drawing), applied_revision: revision } }));
  }
  if (action.type === "undo_outline") {
    if (pageId !== state.active_page_id || !page.outline_undo || page.outline_undo.applied_revision !== page.revision) return state;
    return storePage(state, invalidateChildren({ ...page, drawing: cloneOutlineDrawing(page.outline_undo.drawing),
      revision: page.revision + 1, geometry_revision: page.geometry_revision + 1, outline_undo: undefined }));
  }

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
      if (penetrationAssociationWarnings(proposal, page).length) proposal.validity = "needs_review";
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
        validity: staleChild ? "needs_review" : entry.before.validity,
        edits: [...(current?.edits ?? entry.before.edits), { revision, action: "undo" }] }, annotations);
      annotations.splice(Math.min(entry.index, annotations.length), 0, restored);
    }
  } else if (action.type === "add") {
    if (action.annotation.page_id !== pageId || annotations.some((annotation) => annotation.id === action.annotation.id)) return state;
    const annotation = checkAssociation({ ...cloneAnnotation(action.annotation), revision }, annotations);
    if (penetrationAssociationWarnings(annotation, page).length) annotation.validity = "needs_review";
    annotations.push(annotation);
    history.push({ id: annotation.id, index: annotations.length - 1, before: null, roi_revision: page.roi_revision, geometry_revision: page.geometry_revision });
  } else {
    const current = annotations.find((annotation) => annotation.id === action.id);
    if (!current) return state;
    history.push({ id: current.id, index: annotations.indexOf(current), before: cloneAnnotation(current), roi_revision: page.roi_revision, geometry_revision: page.geometry_revision });
    if (action.type === "remove") annotations = annotations.filter((annotation) => annotation.id !== action.id);
    else {
      const associationEdited = current.kind === "penetration" && (
        (action.patch.box_2d !== undefined && JSON.stringify(action.patch.box_2d) !== JSON.stringify(current.box_2d))
        || (action.patch.roi_id !== undefined && action.patch.roi_id !== current.roi_id)
        || (action.patch.subtype !== undefined && action.patch.subtype !== current.subtype));
      const updated = checkAssociation(cloneAnnotation({ ...current, ...action.patch, revision,
        validity: associationEdited ? "needs_review" : action.patch.validity ?? current.validity,
        edits: [...current.edits, { revision, action: action.patch.box_2d ? "edit" : "review" }] }), annotations);
      // A deliberate move/resize of an active opening updates it immediately.
      // Parent/type changes and boxes with no usable scope still require review.
      if (action.patch.box_2d && current.kind === "penetration" && current.review_status === "accepted"
        && current.validity === "current" && updated.review_status === "accepted"
        && updated.roi_id === current.roi_id && updated.subtype === current.subtype
        && !penetrationFootprint(updated, page).error) updated.validity = "current";
      annotations = annotations.map((annotation) => annotation.id === current.id ? updated : annotation);
    }
  }
  const parents = parentChanges(page.annotations, annotations);
  const next = { ...page, annotations, history: history.slice(-100), revision, roi_revision: page.roi_revision + (parents.size ? 1 : 0) };
  return storePage(state, parents.size ? invalidateChildren(next, parents) : next);
}
