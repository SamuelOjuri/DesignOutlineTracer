import type { RenderedPdfPage } from "@/types/roi";

export function readBlobBytes(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(new Error("Unable to read source image"));
    reader.readAsArrayBuffer(blob);
  });
}

export async function sha256(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function capturePdfPage(
  canvas: HTMLCanvasElement,
  context: Pick<RenderedPdfPage, "document_id" | "file_name" | "page_index" | "render_scale" | "render_rotation" | "render_version" | "pdf_view_box">,
): Promise<RenderedPdfPage> {
  const width = canvas.width;
  const height = canvas.height;
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((result) => result ? resolve(result) : reject(new Error("Unable to capture PDF page")), "image/png");
  });
  const imageHash = await sha256(await readBlobBytes(blob));
  const identity = JSON.stringify([context.document_id, context.page_index, context.render_scale,
    context.render_rotation, context.render_version, context.pdf_view_box, width, height, imageHash]);
  return Object.freeze({
    ...context,
    pdf_view_box: Object.freeze([...context.pdf_view_box]),
    page_id: `page_${await sha256(new TextEncoder().encode(identity).buffer)}`,
    source_image_hash: imageHash,
    source_width: width,
    source_height: height,
    source_blob: blob,
  });
}