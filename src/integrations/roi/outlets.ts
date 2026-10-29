import { z } from "zod";
import { RoiApiError } from "./client";
import { box, hash, identifier, parentSchema } from "./contracts";
import { outletSubtypes, type OutletRequest, type OutletResponse } from "@/types/outlet";

const point = z.object({ x: z.number().finite().nonnegative(), y: z.number().finite().nonnegative() }).strict();
const ring = z.array(point).min(3).max(512);
const warnings = z.array(z.string().max(500)).max(50);
const scopeSignature = z.string().min(1).max(256);

export const outletRequestSchema = z.object({
  contract_version: z.literal("outlet-1"), page_id: identifier, request_id: identifier,
  source_image_hash: hash, scope_signature: scopeSignature,
  roi_revision: z.number().int().nonnegative(), geometry_revision: z.number().int().nonnegative(),
  accepted_rois: z.array(parentSchema).min(1).max(25),
  scopes: z.array(z.object({ roi_id: identifier, outline_id: identifier,
    polygons: z.array(z.object({ outer: ring, holes: z.array(ring).max(64) }).strict()).min(1).max(32),
    excluded_openings: z.array(ring).max(128).optional(),
  }).strict()).min(1).max(25),
}).strict().superRefine((request, context) => {
  const parents = new Set(request.accepted_rois.map(roi => roi.id));
  if (parents.size !== request.accepted_rois.length
    || request.scopes.some(scope => !parents.has(scope.roi_id))
    || new Set(request.scopes.map(scope => `${scope.roi_id}:${scope.outline_id}`)).size !== request.scopes.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid outlet scope association" });
  }
  const vertices = request.scopes.reduce((total, scope) => total + scope.polygons.reduce((sum, polygon) =>
    sum + polygon.outer.length + polygon.holes.reduce((count, hole) => count + hole.length, 0), 0)
    + (scope.excluded_openings ?? []).reduce((count, hole) => count + hole.length, 0), 0);
  if (vertices > 8192) context.addIssue({ code: z.ZodIssueCode.custom, message: "Outlet scope is too complex" });
});

export const outletResponseSchema = z.object({
  contract_version: z.literal("outlet-1"), page_id: identifier, request_id: identifier,
  source_image_hash: hash, scope_signature: scopeSignature,
  status: z.enum(["complete", "partial", "no_detections"]),
  annotations: z.array(z.object({
    id: identifier, page_id: identifier, kind: z.literal("rainwater_outlet"),
    label: z.string().trim().min(1).max(240), subtype: z.enum(outletSubtypes),
    box_2d: box, proposed_box_2d: box, anchor: point, proposed_anchor: point,
    roi_id: identifier, outline_id: identifier, origin: z.literal("gemini"),
    review_status: z.literal("suggested"), validity: z.enum(["current", "needs_review"]),
    revision: z.literal(1), edits: z.array(z.never()).max(0), warnings,
    evidence: z.string().max(1000).optional(),
  }).strict()).max(25), warnings,
  model: z.string().min(1).max(100), prompt_version: z.string().min(1).max(100),
  run: z.record(z.unknown()).optional(),
}).strict();

/** Validate both shape and identity before a result can enter page review state. */
export function validateOutletResponse(request: OutletRequest, payload: unknown): OutletResponse {
  const parsed = outletResponseSchema.safeParse(payload);
  if (!parsed.success) throw new RoiApiError("invalid_contract");
  const result = parsed.data;
  if (result.page_id !== request.page_id || result.request_id !== request.request_id
    || result.source_image_hash !== request.source_image_hash || result.scope_signature !== request.scope_signature) {
    throw new RoiApiError("response_identity_mismatch");
  }
  const scopes = new Set(request.scopes.map(scope => `${scope.roi_id}:${scope.outline_id}`));
  if (new Set(result.annotations.map(annotation => annotation.id)).size !== result.annotations.length
    || (result.status === "no_detections" && result.annotations.length !== 0)
    || (result.status === "complete" && result.annotations.length === 0)
    || (result.status === "partial" && result.warnings.length === 0)
    || result.annotations.some(annotation => annotation.page_id !== request.page_id
      || !scopes.has(`${annotation.roi_id}:${annotation.outline_id}`)
      || JSON.stringify(annotation.box_2d) !== JSON.stringify(annotation.proposed_box_2d)
      || annotation.anchor.x !== annotation.proposed_anchor.x || annotation.anchor.y !== annotation.proposed_anchor.y)) {
    throw new RoiApiError("invalid_response");
  }
  return {
    contract_version: result.contract_version, page_id: result.page_id, request_id: result.request_id,
    source_image_hash: result.source_image_hash, scope_signature: result.scope_signature,
    status: result.status, warnings: result.warnings, model: result.model, prompt_version: result.prompt_version,
    ...(result.run ? { run: result.run } : {}),
    annotations: result.annotations.map(annotation => ({
      id: annotation.id, page_id: annotation.page_id, kind: annotation.kind, label: annotation.label,
      subtype: annotation.subtype, roi_id: annotation.roi_id, outline_id: annotation.outline_id,
      box_2d: [annotation.box_2d[0], annotation.box_2d[1], annotation.box_2d[2], annotation.box_2d[3]],
      proposed_box_2d: [annotation.proposed_box_2d[0], annotation.proposed_box_2d[1], annotation.proposed_box_2d[2], annotation.proposed_box_2d[3]],
      anchor: { x: annotation.anchor.x, y: annotation.anchor.y },
      proposed_anchor: { x: annotation.proposed_anchor.x, y: annotation.proposed_anchor.y },
      origin: annotation.origin, review_status: annotation.review_status, validity: annotation.validity,
      revision: annotation.revision, edits: [], warnings: annotation.warnings,
      ...(annotation.evidence ? { evidence: annotation.evidence } : {}),
    })),
  };
}
