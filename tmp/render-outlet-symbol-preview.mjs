import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const sourcePath = resolve('src/utils/outletMarker.ts');
const compiled = ts.transpileModule(readFileSync(sourcePath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const entry = { exports: {} };
vm.runInNewContext(compiled, { require: createRequire(sourcePath), module: entry, exports: entry.exports });
const { outletMarkerGeometry, drawOutletMarker, OUTLET_COLOUR } = entry.exports;
const roof = [[{ x: -100, y: -100 }, { x: 100, y: -100 }, { x: 100, y: 100 }, { x: -100, y: 100 }]];
const variants = [['Accepted', 'accepted', false], ['Suggested / needs review', 'suggested', false],
  ['Selected (accepted)', 'accepted', true]].map(([label, review_status, selected]) => {
  const strokes = [];
  let path = [], dash = [];
  const ctx = {
    save() {}, restore() {},
    setLineDash(value) { dash = [...value]; },
    beginPath() { path = []; },
    arc(x, y, radius, start, end) { path.push({ type: 'arc', x, y, radius, start, end }); },
    moveTo(x, y) { path.push({ type: 'move', x, y }); },
    lineTo(x, y) { path.push({ type: 'line', x, y }); },
    stroke() { strokes.push({ path: [...path], dash: [...dash], width: this.lineWidth, colour: this.strokeStyle }); },
  };
  const outlet = { x: 0, y: 0, review_status };
  const geometry = outletMarkerGeometry(outlet, roof, [], 1);
  drawOutletMarker(ctx, outlet, geometry, selected);
  return { label, strokes };
});
writeFileSync('tmp/outlet-symbol-preview.json', JSON.stringify({ colour: OUTLET_COLOUR, variants }, null, 2));
console.log('Recorded three outlet symbols directly from the current renderer.');
