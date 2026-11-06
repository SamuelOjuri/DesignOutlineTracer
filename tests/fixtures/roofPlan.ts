import { Buffer } from "node:buffer";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

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

export async function createPenetrationPlanPdf() {
  const document = await PDFDocument.create();
  document.setCreationDate(new Date("2026-09-10T00:00:00Z"));
  document.setModificationDate(new Date("2026-09-10T00:00:00Z"));
  document.setTitle("Synthetic penetration review contract fixture");
  for (const pageIndex of [0, 1]) {
    const page = document.addPage([300, 200]);
    const points = [{ x: 30, y: 40 }, { x: 70, y: 40 }, { x: 70, y: 100 },
      { x: 130, y: 100 }, { x: 130, y: 140 }, { x: 30, y: 140 }];
    points.forEach((point, index) => page.drawLine({ start: point, end: points[(index + 1) % points.length], thickness: 2 }));
    page.drawRectangle({ x: 195, y: 150, width: 60, height: 30, borderWidth: 2, borderColor: rgb(0, 0, 0), color: rgb(1, 1, 1) });
    if (pageIndex === 0) {
      for (const symbol of [{ x: 54, y: 110, width: 12, height: 10 }, { x: 210, y: 164, width: 12, height: 6 },
        { x: 150, y: 20, width: 15, height: 10 }, { x: 105, y: 62, width: 9, height: 8 }]) {
        page.drawRectangle({ ...symbol, borderWidth: 1, borderColor: rgb(0, 0, 0), color: rgb(1, 1, 1) });
      }
    }
  }
  return { name: "synthetic-penetrations.pdf", mimeType: "application/pdf", buffer: Buffer.from(await document.save()) };
}

export async function createOpenRoofPlanPdf() {
  const document = await PDFDocument.create();
  for (let index = 0; index < 2; index++) {
    const page = document.addPage([300, 200]);
    // An open top lets unrestricted filling reach the page background.
    for (const [start, end] of [
      [{ x: 60, y: 160 }, { x: 60, y: 40 }],
      [{ x: 60, y: 40 }, { x: 240, y: 40 }],
      [{ x: 240, y: 40 }, { x: 240, y: 160 }],
    ]) page.drawLine({ start, end, thickness: 1 });
    page.drawRectangle({ x: 140, y: 90, width: 20, height: 20, borderWidth: 1, borderColor: rgb(0, 0, 0) });
  }
  return { name: "synthetic-open-roof.pdf", mimeType: "application/pdf", buffer: Buffer.from(await document.save()) };
}

/** Rotated boundary whose lower right side has a small inward return. Coordinates are in source pixels. */
export async function createRedrawPlanPdf() {
  const rotate = ({ x, y }: { x: number; y: number }) => {
    const angle = Math.PI / 9, dx = x - 300, dy = y - 200;
    return { x: 300 + dx * Math.cos(angle) - dy * Math.sin(angle),
      y: 200 + dx * Math.sin(angle) + dy * Math.cos(angle) };
  };
  const original = [{ x: 160, y: 110 }, { x: 430, y: 110 }, { x: 430, y: 290 }, { x: 160, y: 290 }].map(rotate);
  const start = rotate({ x: 430, y: 200 }), corner = rotate({ x: 405, y: 200 }), end = rotate({ x: 405, y: 290 });
  const corrected = [original[0], original[1], start, corner, end, original[3]];
  const document = await PDFDocument.create();
  const page = document.addPage([300, 200]);
  const pdfPoint = ({ x, y }: { x: number; y: number }) => ({ x: x / 2, y: 200 - y / 2 });
  corrected.forEach((point, index) => page.drawLine({ start: pdfPoint(point),
    end: pdfPoint(corrected[(index + 1) % corrected.length]), thickness: 0.5, color: rgb(0, 0, 0) }));
  return { file: { name: "synthetic-rotated-return.pdf", mimeType: "application/pdf", buffer: Buffer.from(await document.save()) },
    original, corrected, start, corner, end };
}

/** Synthetic stand-in for the CRM "Project Performance Specification Details" export (label: value lines). */
export async function createSpecificationPdf() {
  const document = await PDFDocument.create();
  const fixtureDate = new Date("2026-10-30T00:00:00Z");
  document.setCreationDate(fixtureDate);
  document.setModificationDate(fixtureDate);
  document.setTitle("Synthetic performance specification fixture");
  const page = document.addPage([595, 842]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  page.drawText("Project Performance Specification Details", { x: 50, y: 780, size: 16, font });
  ["Scale: 1:100", "Page Size: ISO A1", "Drawing Title: Synthetic Terrace", "Target U Value: 0.25",
    "Target Min U Value: 0.35", "Membrane: Not Provided", "Decking: Timber (18mm)"]
    .forEach((line, index) => page.drawText(line, { x: 50, y: 740 - index * 24, size: 11, font }));
  return { name: "Project_Performance_Specification_Details_synthetic.pdf", mimeType: "application/pdf",
    buffer: Buffer.from(await document.save()) };
}
