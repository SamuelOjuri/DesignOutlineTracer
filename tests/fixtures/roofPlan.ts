import { Buffer } from "node:buffer";
import { PDFDocument, rgb } from "pdf-lib";

export async function createRoofPlanPdf() {
  const document = await PDFDocument.create();
  const fixtureDate = new Date("2026-09-09T00:00:00Z");
  document.setCreationDate(fixtureDate);
  document.setModificationDate(fixtureDate);
  document.setTitle("Synthetic manual-flow regression fixture");
  for (const left of [30, 160]) {
    const page = document.addPage([300, 200]);
    page.drawRectangle({
      x: left, y: 40, width: 100, height: 100,
      borderWidth: 2, borderColor: rgb(0, 0, 0), color: rgb(1, 1, 1),
    });
  }
  return { name: "synthetic-two-page-roof.pdf", mimeType: "application/pdf", buffer: Buffer.from(await document.save()) };
}