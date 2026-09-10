import { z } from "zod";

export const identifier = z.string().min(1).max(200).regex(/^[a-zA-Z0-9_-]+$/);
export const hash = z.string().regex(/^[a-f0-9]{64}$/);
const coordinate = z.number().finite().min(0).max(1000);
export const box = z.tuple([coordinate, coordinate, coordinate, coordinate])
  .refine(([ymin, xmin, ymax, xmax]) => ymin < ymax && xmin < xmax);
export const task = z.enum(["roof_roi", "penetration", "rainwater_outlet"]);
const status = z.enum(["complete", "no_detections", "partial"]);
const warnings = z.array(z.string().max(500)).max(50);
const subtype = z.enum(["rooflight", "vent", "flue", "access_hatch", "internal_outlet", "parapet_outlet", "scupper"]);
export const subtypes = {
  roof_roi: [], penetration: ["rooflight", "vent", "flue", "access_hatch"],
  rainwater_outlet: ["internal_outlet", "parapet_outlet", "scupper"],
};

export const pageContextSchema = z.object({
  document_id: identifier, file_name: z.string().min(1).max(255), page_id: identifier,
  page_index: z.number().int().nonnegative(), source_image_hash: hash,
  source_width: z.number().int().positive(), source_height: z.number().int().positive(),
  render_scale: z.number().finite().positive(), render_rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
  render_version: z.string().min(1).max(160),
  pdf_view_box: z.tuple([z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite()]),
}).strict();

export const receiptSchema = z.object({
  page: pageContextSchema, upload_id: identifier, expires_in_seconds: z.number().finite().nonnegative(),
}).strict();

export const requestSchema = z.object({
  page_id: identifier, request_id: identifier, task, source_image_hash: hash,
  roi_revision: z.number().int().nonnegative().nullable(), geometry_revision: z.number().int().nonnegative(),
}).strict();

export const parentSchema = z.object({ id: identifier, revision: z.number().int().positive(), box_2d: box }).strict();

const annotationSchema = z.object({
  id: identifier, page_id: identifier, kind: task, label: z.string().trim().min(1).max(240),
  subtype: subtype.nullish().transform((value) => value ?? undefined), box_2d: box, proposed_box_2d: box,
  roi_id: identifier.nullable(), origin: z.literal("gemini"), review_status: z.literal("suggested"),
  validity: z.literal("current"), revision: z.literal(1), edits: z.array(z.never()).max(0), warnings,
}).strict();

const runSchema = requestSchema.extend({
  model: z.literal("gemini-3.6-flash"), prompt_version: z.string().min(1).max(100), schema_version: z.literal("1"),
  settings: z.record(z.unknown()), started_at: z.string().datetime({ offset: true }),
  duration_ms: z.number().finite().nonnegative(), status, warnings,
  cached: z.boolean(), provider_attempts: z.number().int().min(0).max(2),
}).strict();

export const detectionSchema = z.object({
  schema_version: z.literal("1"), page_id: identifier, request_id: identifier, task, status,
  roi_revision: z.number().int().nonnegative().nullable(), model: z.literal("gemini-3.6-flash"),
  prompt_version: z.string().min(1).max(100), annotations: z.array(annotationSchema).max(25), warnings, run: runSchema,
}).strict();

export const healthSchema = z.object({
  status: z.enum(["ready", "not_configured"]), model: z.literal("gemini-3.6-flash"), mode: z.literal("localhost_only"),
}).strict();