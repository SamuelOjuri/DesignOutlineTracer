import { strToU8, zipSync, type Zippable } from "fflate";
import type { ProjectDetails } from "@/types/roof";
import { readBlobBytes, sha256 } from "./roiSource";
import { projectDetailsCsv } from "./projectDetailsCsv";
import {
  DRAWING_EXPORT_VERSION, roofExportDxf, roofExportGeoJson, roofExportMetadata, roofExportSvg, type RoofExportModel,
} from "./drawingExport";
import { buildTricsPrompt, TRICS_PROMPT_VERSION } from "./tricsPrompt";

export const PACKAGE_VERSION = "tpid-package-v1";

export const PACKAGE_PATHS = {
  manifest: "manifest.json",
  specFolder: "1_spec",
  details: "2_details/project_details.csv",
  roofPlanFolder: "3_roof_plan",
  dxf: "4_drawing/roof_outline.dxf",
  svg: "4_drawing/roof_outline.svg",
  geojson: "4_drawing/roof_outline.geojson",
  drawingPng: "4_drawing/roof_drawing.png",
  maskPng: "4_drawing/roof_mask.png",
  metadata: "4_drawing/roof_metadata.json",
  drawingFolder: "4_drawing",
  prompt: "5_prompt/TRICS_design_prompt.md",
} as const;

export type PackageFileRole =
  | "performance_specification" | "project_details" | "roof_plan" | "drawing_dxf" | "drawing_svg" | "drawing_geojson"
  | "drawing_png" | "drawing_mask_png" | "drawing_metadata" | "roof_plan_marked_up" | "trics_prompt";

export interface ManifestFile {
  path: string;
  role: PackageFileRole;
  media_type: string;
  bytes: number;
  sha256: string;
  original_file_name?: string;
  source_page?: { document_id: string; page_id: string; page_index: number };
}

export interface PackageManifest {
  package_version: typeof PACKAGE_VERSION;
  generated_at: string;
  generator: string;
  drawing_export_version: typeof DRAWING_EXPORT_VERSION;
  prompt_template_version: typeof TRICS_PROMPT_VERSION;
  source_separation: string;
  performance_specification_supplied: boolean;
  files: ManifestFile[];
}

export interface MarkedUpPage {
  document_id: string;
  page_id: string;
  page_index: number;
  blob: Blob;
}

export interface PackageInput {
  projectDetails: ProjectDetails;
  specDocument: File | null;
  roofPlans: File[];
  model: RoofExportModel;
  drawingPng: Blob;
  maskPng: Blob;
  markedUpPages: MarkedUpPage[];
  generatedAt: Date;
}

export interface ProjectPackage {
  blob: Blob;
  fileName: string;
  manifest: PackageManifest;
}

/** Keeps the original name where possible; removes characters invalid in Windows/zip paths. */
export function safeFileName(name: string, fallback: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/\s+/g, " ").trim().replace(/^\.+/, "");
  if (!cleaned) return fallback;
  if (cleaned.length <= 180) return cleaned;
  const dot = cleaned.lastIndexOf(".");
  const extension = dot > 0 && cleaned.length - dot <= 10 ? cleaned.slice(dot) : "";
  return cleaned.slice(0, 180 - extension.length) + extension;
}

function uniquePath(path: string, used: Set<string>): string {
  if (!used.has(path.toLowerCase())) {
    used.add(path.toLowerCase());
    return path;
  }
  const dot = path.lastIndexOf(".");
  const [stem, extension] = dot > path.lastIndexOf("/") ? [path.slice(0, dot), path.slice(dot)] : [path, ""];
  for (let index = 2; ; index++) {
    const candidate = `${stem} (${index})${extension}`;
    if (!used.has(candidate.toLowerCase())) {
      used.add(candidate.toLowerCase());
      return candidate;
    }
  }
}

const pad = (value: number) => String(value).padStart(2, "0");

export function packageFileName(projectName: string, generatedAt: Date): string {
  const slug = projectName.normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s-]+/g, "_").slice(0, 60);
  const stamp = `${generatedAt.getFullYear()}${pad(generatedAt.getMonth() + 1)}${pad(generatedAt.getDate())}`
    + `-${pad(generatedAt.getHours())}${pad(generatedAt.getMinutes())}`;
  return `TPID_${slug || "roof"}_${stamp}.zip`;
}

const bytesOf = async (blob: Blob) => new Uint8Array(await readBlobBytes(blob));

/** Assembles the TRICS package. PDFs are stored byte-for-byte; the form CSV is kept separate from the specification. */
export async function buildProjectPackage(input: PackageInput): Promise<ProjectPackage> {
  const generatedAt = input.generatedAt.toISOString();
  const used = new Set<string>([PACKAGE_PATHS.manifest.toLowerCase()]);
  const entries: { path: string; data: Uint8Array; compress: boolean; manifest: Omit<ManifestFile, "path" | "bytes" | "sha256"> }[] = [];
  const add = (path: string, data: Uint8Array, compress: boolean, manifest: Omit<ManifestFile, "path" | "bytes" | "sha256">) => {
    const unique = uniquePath(path, used);
    entries.push({ path: unique, data, compress, manifest });
    return unique;
  };

  const specificationPath = input.specDocument
    ? add(`${PACKAGE_PATHS.specFolder}/${safeFileName(input.specDocument.name, "performance_specification.pdf")}`,
      await bytesOf(input.specDocument), false,
      { role: "performance_specification", media_type: input.specDocument.type || "application/pdf", original_file_name: input.specDocument.name })
    : null;
  add(PACKAGE_PATHS.details, strToU8(projectDetailsCsv(input.projectDetails)), true,
    { role: "project_details", media_type: "text/csv" });
  const roofPlanPaths: string[] = [];
  for (const file of input.roofPlans) {
    roofPlanPaths.push(add(`${PACKAGE_PATHS.roofPlanFolder}/${safeFileName(file.name, "roof_plan.pdf")}`, await bytesOf(file), false,
      { role: "roof_plan", media_type: file.type || "application/pdf", original_file_name: file.name }));
  }

  const dxf = add(PACKAGE_PATHS.dxf, strToU8(roofExportDxf(input.model)), true, { role: "drawing_dxf", media_type: "image/vnd.dxf" });
  const svg = add(PACKAGE_PATHS.svg, strToU8(roofExportSvg(input.model)), true, { role: "drawing_svg", media_type: "image/svg+xml" });
  const geojson = add(PACKAGE_PATHS.geojson, strToU8(roofExportGeoJson(input.model)), true,
    { role: "drawing_geojson", media_type: "application/geo+json" });
  const drawingPng = add(PACKAGE_PATHS.drawingPng, await bytesOf(input.drawingPng), false, { role: "drawing_png", media_type: "image/png" });
  const maskPng = add(PACKAGE_PATHS.maskPng, await bytesOf(input.maskPng), false, { role: "drawing_mask_png", media_type: "image/png" });
  const metadata = add(PACKAGE_PATHS.metadata, strToU8(roofExportMetadata(input.model, generatedAt)), true,
    { role: "drawing_metadata", media_type: "application/json" });
  const markedUp: string[] = [];
  for (const page of input.markedUpPages) {
    markedUp.push(add(`${PACKAGE_PATHS.drawingFolder}/roof_plan_marked_up_p${page.page_index + 1}.png`, await bytesOf(page.blob), false,
      { role: "roof_plan_marked_up", media_type: "image/png",
        source_page: { document_id: page.document_id, page_id: page.page_id, page_index: page.page_index } }));
  }

  const prompt = buildTricsPrompt(input.model, { specification: specificationPath, details: PACKAGE_PATHS.details,
    roofPlans: roofPlanPaths, dxf, svg, geojson, metadata, drawingPng, maskPng, markedUp }, generatedAt);
  add(PACKAGE_PATHS.prompt, strToU8(prompt), true, { role: "trics_prompt", media_type: "text/markdown" });

  const files: ManifestFile[] = [];
  for (const entry of entries) {
    files.push({ path: entry.path, bytes: entry.data.byteLength, sha256: await sha256(entry.data.slice().buffer), ...entry.manifest });
  }
  const manifest: PackageManifest = {
    package_version: PACKAGE_VERSION, generated_at: generatedAt, generator: "TaperedPlus XPress - New Build",
    drawing_export_version: DRAWING_EXPORT_VERSION, prompt_template_version: TRICS_PROMPT_VERSION,
    source_separation: "The performance specification document is included unmodified. Project details entered in the form are "
      + "in the CSV only; the form does not ask for the requirements covered by the specification.",
    performance_specification_supplied: specificationPath !== null,
    files,
  };

  const mtime = input.generatedAt;
  const zippable: Zippable = { [PACKAGE_PATHS.manifest]: [strToU8(`${JSON.stringify(manifest, null, 2)}\n`), { level: 6, mtime }] };
  for (const entry of entries) zippable[entry.path] = [entry.data, { level: entry.compress ? 6 : 0, mtime }];
  const zipped = zipSync(zippable);
  return { blob: new Blob([zipped], { type: "application/zip" }),
    fileName: packageFileName(input.projectDetails.projectName, input.generatedAt), manifest };
}
