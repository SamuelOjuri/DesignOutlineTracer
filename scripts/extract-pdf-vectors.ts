/**
 * Extract PDF vector segments exactly as the browser upload does, for offline outline evaluation.
 *
 * Usage: npx vite-node scripts/extract-pdf-vectors.ts <pdf> <page-number> <output.json> [scale=2]
 * Coordinates are source pixels of a PDF.js viewport at the given scale (the app uses 2).
 */
import { readFileSync, writeFileSync } from "node:fs";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { extractPdfVectorSegments } from "@/utils/pdfVectorSegments";

const [pdfPath, pageText, outputPath, scaleText = "2"] = process.argv.slice(2);
const pageNumber = Number(pageText);
const scale = Number(scaleText);
if (!pdfPath || !outputPath || !Number.isInteger(pageNumber) || pageNumber < 1 || !(scale > 0)) {
  console.error("usage: extract-pdf-vectors.ts <pdf> <page-number> <output.json> [scale]");
  process.exit(2);
}

const pdf = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(pdfPath)), isEvalSupported: false }).promise;
const page = await pdf.getPage(pageNumber);
const viewport = page.getViewport({ scale });
const width = Math.floor(viewport.width), height = Math.floor(viewport.height);
const segments = extractPdfVectorSegments(await page.getOperatorList(), viewport.transform, width, height);
writeFileSync(outputPath, JSON.stringify({
  extractor: `pdfjs-${pdfjs.version}-pdfVectorSegments`, page_index: pageNumber - 1, scale, width, height, segments,
}));
console.log(JSON.stringify({ segments: segments.length, width, height }));
