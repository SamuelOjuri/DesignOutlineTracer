import { z } from "zod";
import type { DetectionRequest, DetectionRun, RenderedPdfPage, RoiAnnotation } from "@/types/roi";
import {
  detectionSchema, healthSchema, identifier, pageContextSchema, parentSchema, receiptSchema, requestSchema, subtypes,
} from "./contracts";

export class RoiApiError extends Error {
  constructor(public readonly code: string, public readonly status = 0, public readonly retryable = false) {
    super(`ROI request failed: ${code}`);
    this.name = "RoiApiError";
  }
}

export interface RoiDetectionResult {
  schema_version: "1";
  page_id: string;
  request_id: string;
  task: DetectionRequest["task"];
  status: DetectionRun["status"];
  roi_revision: number | null;
  model: string;
  prompt_version: string;
  annotations: RoiAnnotation[];
  warnings: string[];
  run: DetectionRun & { cached: boolean; provider_attempts: number };
}

interface ClientOptions {
  enabled?: boolean;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

interface DetectionOptions {
  acceptedRois?: readonly RoiAnnotation[];
  signal?: AbortSignal;
  followUpOf?: string;
}

function validate<Schema extends z.ZodTypeAny>(schema: Schema, value: unknown): z.output<Schema> {
  const result = schema.safeParse(value);
  if (!result.success) throw new RoiApiError("invalid_contract");
  return result.data;
}

async function readJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new RoiApiError("invalid_response");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "";
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024 * 1024) throw new RoiApiError("response_too_large");
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof RoiApiError) throw error;
    throw new RoiApiError("invalid_response");
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export function createRoiClient(options: ClientOptions = {}) {
  const enabled = options.enabled ?? import.meta.env.VITE_ROI_ENABLED === "true";
  const baseUrl = options.baseUrl ?? import.meta.env.VITE_ROI_API_BASE_URL;
  const fetcher = options.fetch ?? globalThis.fetch;
  let sessionToken: string | undefined;

  function ensureEnabled() {
    if (!enabled) throw new RoiApiError("feature_disabled");
  }

  function endpoint(path: string) {
    ensureEnabled();
    try {
      const url = new URL(baseUrl);
      if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
        || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
        throw new Error("invalid_base_url");
      }
      return `${url.origin}/api/roi/v1${path}`;
    } catch {
      throw new RoiApiError("invalid_configuration");
    }
  }

  async function send(path: string, method: string, body?: BodyInit, signal?: AbortSignal): Promise<unknown> {
    const url = endpoint(path);
    if (signal?.aborted) throw new DOMException("Request aborted", "AbortError");
    if (!sessionToken) {
      sessionToken = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("");
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, options.timeoutMs ?? 70000);
    try {
      const response = await fetcher(url, {
        method, body, signal: controller.signal, credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer",
        headers: { Authorization: `Bearer ${sessionToken}`, ...(typeof body === "string" ? { "Content-Type": "application/json" } : {}) },
      });
      if (response.status === 204 && method === "DELETE") return undefined;
      const payload = await readJson(response);
      if (!response.ok) {
        const parsed = z.object({ error: z.object({ code: z.string().max(80).regex(/^[a-z_]+$/), retryable: z.boolean() }).strict() })
          .strict().safeParse(payload);
        if (!parsed.success) throw new RoiApiError("request_failed", response.status);
        throw new RoiApiError(parsed.data.error.code, response.status, parsed.data.error.retryable);
      }
      return payload;
    } catch (error) {
      if (signal?.aborted) throw new DOMException("Request aborted", "AbortError");
      if (timedOut) throw new RoiApiError("request_timeout");
      if (error instanceof RoiApiError) throw error;
      throw new RoiApiError("network_error");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  return {
    enabled,
    async health(signal?: AbortSignal) {
      return validate(healthSchema, await send("/health", "GET", undefined, signal));
    },
    async uploadPage(page: RenderedPdfPage, signal?: AbortSignal) {
      ensureEnabled();
      const { source_blob, ...context } = page;
      const validated = validate(pageContextSchema, context);
      const body = new FormData();
      body.set("context", JSON.stringify(validated));
      body.set("image", source_blob, "source-page.png");
      const receipt = validate(receiptSchema, await send("/pages", "POST", body, signal));
      if (JSON.stringify(receipt.page) !== JSON.stringify(validated)) throw new RoiApiError("response_identity_mismatch");
      return receipt;
    },
    async detect(request: DetectionRequest, detectionOptions: DetectionOptions = {}): Promise<RoiDetectionResult> {
      ensureEnabled();
      const identity = validate(requestSchema, request);
      const rois = detectionOptions.acceptedRois ?? [];
      if (rois.length > 25 || rois.some((roi) => roi.page_id !== identity.page_id || roi.kind !== "roof_roi"
        || roi.review_status !== "accepted" || roi.validity !== "current")) throw new RoiApiError("invalid_parents");
      const parents = rois.map((roi) => validate(parentSchema, { id: roi.id, revision: roi.revision, box_2d: roi.box_2d }));
      const parentIds = new Set(parents.map((parent) => parent.id));
      if (parentIds.size !== parents.length || (identity.task === "roof_roi"
        ? parents.length !== 0 || identity.roi_revision !== null : parents.length === 0 || identity.roi_revision === null)) {
        throw new RoiApiError("invalid_parents");
      }
      const followUpOf = detectionOptions.followUpOf === undefined ? undefined : validate(identifier, detectionOptions.followUpOf);
      const payload = { ...identity, accepted_rois: parents, ...(followUpOf ? { follow_up_of: followUpOf } : {}) };
      const result = validate(detectionSchema, await send(`/pages/${identity.page_id}/detections`, "POST", JSON.stringify(payload), detectionOptions.signal));
      if (result.page_id !== identity.page_id || result.request_id !== identity.request_id || result.task !== identity.task
        || result.roi_revision !== identity.roi_revision || result.status !== result.run.status || result.prompt_version !== result.run.prompt_version
        || Object.entries(identity).some(([key, value]) => result.run[key] !== value)) throw new RoiApiError("response_identity_mismatch");
      if (new Set(result.annotations.map((annotation) => annotation.id)).size !== result.annotations.length
        || (result.status === "no_detections" && result.annotations.length !== 0)
        || (result.status === "complete" && result.annotations.length === 0)
        || (result.status === "partial" && result.warnings.length === 0)
        || result.annotations.some((annotation) => annotation.page_id !== identity.page_id || annotation.kind !== identity.task
          || JSON.stringify(annotation.box_2d) !== JSON.stringify(annotation.proposed_box_2d)
          || (identity.task === "roof_roi" ? annotation.roi_id !== null || annotation.subtype !== undefined
            : !parentIds.has(annotation.roi_id) || !subtypes[identity.task].includes(annotation.subtype)))) {
        throw new RoiApiError("invalid_response");
      }
      return {
        schema_version: result.schema_version, page_id: result.page_id, request_id: result.request_id,
        task: result.task, status: result.status, roi_revision: result.roi_revision,
        model: result.model, prompt_version: result.prompt_version, warnings: result.warnings,
        annotations: result.annotations.map((annotation) => ({
          id: annotation.id, page_id: annotation.page_id, kind: annotation.kind, label: annotation.label, subtype: annotation.subtype,
          box_2d: [annotation.box_2d[0], annotation.box_2d[1], annotation.box_2d[2], annotation.box_2d[3]],
          proposed_box_2d: [annotation.proposed_box_2d[0], annotation.proposed_box_2d[1], annotation.proposed_box_2d[2], annotation.proposed_box_2d[3]],
          roi_id: annotation.roi_id, origin: annotation.origin, review_status: annotation.review_status,
          validity: annotation.validity, revision: annotation.revision, edits: [], warnings: annotation.warnings,
        })),
        run: { page_id: identity.page_id, request_id: identity.request_id, task: identity.task,
          source_image_hash: identity.source_image_hash, roi_revision: identity.roi_revision, geometry_revision: identity.geometry_revision,
          model: result.run.model, prompt_version: result.run.prompt_version, schema_version: result.run.schema_version,
          settings: result.run.settings, started_at: result.run.started_at, duration_ms: result.run.duration_ms,
          status: result.run.status, warnings: result.run.warnings, cached: result.run.cached, provider_attempts: result.run.provider_attempts },
      };
    },
    async deletePage(pageId: string, signal?: AbortSignal) {
      ensureEnabled();
      await send(`/pages/${validate(identifier, pageId)}`, "DELETE", undefined, signal);
    },
  };
}

export const roiClient = createRoiClient();