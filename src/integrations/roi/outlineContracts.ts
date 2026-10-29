import { z } from "zod";
import { box, hash, identifier } from "./contracts";

const point = z.object({ x: z.number().finite().nonnegative(), y: z.number().finite().nonnegative() }).strict();
const ring = z.array(point).min(3).max(128);
const warnings = z.array(z.string().max(500)).max(50);
export const boundaryPolicySchema = z.enum(["inner_parapet", "roof_deck", "outer_roof"]);
export const outlineRequestSchema = z.object({
  schema_version: z.literal("outline-1"), page_id: identifier, request_id: identifier, source_image_hash: hash,
  roi_revision: z.number().int().nonnegative(), geometry_revision: z.number().int().nonnegative(),
  roi: z.object({ id: identifier, revision: z.number().int().positive(), box_2d: box }).strict(),
  boundary_policy: boundaryPolicySchema, boundary_notes: z.string().max(1000),
  vector_segments: z.array(z.object({ start: point, end: point }).strict()).max(2000),
}).strict();
export const outlineResponseSchema = z.object({
  schema_version: z.literal("outline-1"), page_id: identifier, request_id: identifier, source_image_hash: hash,
  roi_revision: z.number().int().nonnegative(), geometry_revision: z.number().int().nonnegative(),
  roi_id: identifier, roi_annotation_revision: z.number().int().positive(), boundary_policy: boundaryPolicySchema,
  status: z.enum(["complete", "needs_review", "no_outline", "roi_too_tight"]),
  proposals: z.array(z.object({
    id: identifier, points: ring, proposed_points: ring, warnings,
    edges: z.array(z.object({ index: z.number().int().nonnegative().max(127), support: z.number().finite().min(0).max(1),
      source: z.enum(["vector", "raster", "unsupported"]), ambiguous: z.boolean() }).strict()).min(3).max(128),
  }).strict()).max(8), warnings,
  crop: z.object({ x: z.number().finite().nonnegative(), y: z.number().finite().nonnegative(),
    width: z.number().finite().positive(), height: z.number().finite().positive(),
    inference_width: z.number().int().positive(), inference_height: z.number().int().positive() }).strict(),
  run: z.object({ model: z.string().min(1).max(100), prompt_version: z.string().min(1).max(100),
    algorithm_version: z.string().min(1).max(100), settings: z.record(z.unknown()), duration_ms: z.number().finite().nonnegative(),
    cached: z.boolean(), provider_attempts: z.number().int().min(0).max(2) }).strict(),
}).strict().superRefine((value, context) => {
  if ((value.status === "complete" || value.status === "needs_review") !== (value.proposals.length > 0)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Outline status does not match proposals" });
  }
  if (new Set(value.proposals.map(p => p.id)).size !== value.proposals.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Duplicate proposal identity" });
  }
  for (const proposal of value.proposals) {
    if (proposal.edges.length !== proposal.points.length || proposal.edges.some((edge, index) => edge.index !== index)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid edge evidence mapping" });
    }
  }
});
