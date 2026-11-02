import { readBlobBytes } from "./roiSource";

export const MAX_SPEC_DOCUMENT_BYTES = 25 * 1024 * 1024;

export async function validateSpecDocument(file: File): Promise<string | null> {
  if (file.type !== "application/pdf" && !/\.pdf$/i.test(file.name)) return "Choose a PDF file.";
  if (file.size === 0) return "The selected PDF is empty.";
  if (file.size > MAX_SPEC_DOCUMENT_BYTES) return "The PDF is larger than 25 MB.";
  const header = new TextDecoder("latin1").decode(new Uint8Array(await readBlobBytes(file.slice(0, 1024))));
  return header.includes("%PDF-") ? null : "The selected file is not a valid PDF.";
}

export const formatFileSize = (bytes: number) =>
  bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
