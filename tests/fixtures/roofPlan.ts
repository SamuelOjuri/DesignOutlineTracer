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
