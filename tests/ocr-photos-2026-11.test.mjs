// Run with: node --test tests/ocr-photos-2026-11.test.mjs
// Regression tests from REAL phone photos of Windows Settings / battery-report screens (ROG Zephyrus M16, Surface Laptop 4, Ryzen 5 5600G PC).
// The text is what Tesseract returned for the full photo and for a crop of just the lit screen; machine names and IDs are masked.
// Covers: the screen-crop finder (scBoxFromGray), "Radeon" misreads, "with Radeon Graphics" cut off, a model cut off at the photo edge, and crop + full text read together.
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, '..', 'index.html'), 'utf8');
const REAL = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'real-ocr-photos-2026-11.json'), 'utf8'));
const THUMBS = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'screen-thumbs-2026-11.json'), 'utf8'));
const constLine = name => { const m = html.match(new RegExp('^const ' + name + '=.*$', 'm')); if (!m) throw new Error(name + ' not found'); return m[0]; };
function fnBlock(name) {
  const start = html.indexOf('function ' + name + '(');
  if (start < 0) throw new Error(name + ' not found');
  let i = html.indexOf('{', html.indexOf(')', start)), d = 0;
  for (; i < html.length; i++) {
    if (html[i] === '{') d++;
    else if (html[i] === '}') { d--; if (d === 0) return html.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces in ' + name);
}
const parseBlock = html.slice(html.indexOf('/*OCR-PARSE-START*/'), html.indexOf('/*OCR-PARSE-END*/'));
const ctx = vm.createContext({});
vm.runInContext([constLine('scTxt'), constLine('scIdN'), fnBlock('scLuhn'), fnBlock('scMarketed'), 'const SC_SIZES=[16,32,64,128,256,512,1024,2048,4096];', parseBlock, 'globalThis.__t={scOcrParse,scBoxFromGray};'].join('\n'), ctx);
const T = ctx.__t, J = x => JSON.parse(JSON.stringify(x));
const textOf = (e, kind) => e[kind].psm3.text + '\n' + e[kind].psm11.text;
const conf = e => Math.max(...['full', 'crop'].filter(k => e[k]).flatMap(k => [e[k].psm3.conf, e[k].psm11.conf]));
// the site's real order: the cropped screen text first, then the full-frame text
const read = e => J(T.scOcrParse([{ n: 1, text: (e.crop ? textOf(e, 'crop') + '\n' : '') + textOf(e, 'full'), conf: conf(e), words: [] }]));
const note = (r, s) => r.notes.some(n => n.text.includes(s));

test('ROG Zephyrus About photo: model (written twice by Windows) is kept once, every spec right', () => {
  const r = read(REAL.rog_about_angled);
  assert.equal(r.fields.model.value, 'ROG Zephyrus M16 GU603ZM');
  assert.match(r.fields.cpu.value, /i7-12700H/);
  assert.match(r.fields.gpu1.value, /RTX 3060/);
  assert.equal(r.fields.ram.value, '16 GB');
  assert.equal(r.fields.storage.totalGB, 954);
  assert.equal(r.fields.os.value, 'Windows 11 Home');
  assert.deepEqual(r.conflicts, []);
});
test('battery report photo: the model cut off at the photo edge is completed from the BIOS line, health and cycles read', () => {
  const r = read(REAL.rog_battery_report);
  assert.equal(r.fields.model.value, 'ROG Zephyrus M16 GU603ZM');
  assert.equal(r.fields.serial, null, 'the battery serial is never the computer serial');
  assert.ok(note(r, 'Battery health 69%'));
  assert.ok(note(r, 'Cycle count 320'));
});
test('advanced display photo: resolution and refresh rate are noted', () => {
  const r = read(REAL.rog_display_advanced);
  assert.ok(note(r, '2560') && note(r, '165'));
});
test('Surface photo taken at an angle with the keyboard in frame: the crop pass fills model, drive and OS', () => {
  const r = read(REAL.surface_about_angled_with_keyboard);
  assert.equal(r.fields.model.value, 'Surface Laptop 4');
  assert.match(r.fields.cpu.value, /i5-1145G7/);
  assert.equal(r.fields.ram.value, '16 GB');
  assert.equal(r.fields.storage.totalGB, 477);
  assert.equal(r.fields.os.value, 'Windows 11 Pro');
  assert.deepEqual(r.conflicts, []);
});
test('Surface screenshot photographed sideways (already turned by the reader): still all right', () => {
  const r = read(REAL.surface_about_sideways);
  assert.equal(r.fields.model.value, 'Surface Laptop 4');
  assert.equal(r.fields.storage.totalGB, 477);
  assert.equal(r.fields.os.value, 'Windows 11 Pro');
});
test('Ryzen monitor photo with glare: "with Radeon Graphics" is not part of the CPU, a misread Radeon is repaired, no invented second graphics card', () => {
  const r = read(REAL.ryzen_about_monitor_glare);
  assert.equal(r.fields.cpu.value, 'AMD Ryzen 5 5600G');
  assert.match(r.fields.gpu1.value, /^AMD Radeon RX\s?590 GME$/);
  assert.equal(r.fields.gpu2, null, '"Radeon Hava" is noise, not a card');
  assert.equal(r.fields.ram.value, '16 GB');
  assert.equal(r.fields.storage.totalGB, 954);
  assert.equal(r.fields.serial, null);
});
test('the same photos read from the full frame alone never produce a WRONG value (blank is allowed)', () => {
  for (const [k, e] of Object.entries(REAL)) {
    const r = J(T.scOcrParse([{ n: 1, text: textOf(e, 'full'), conf: 80, words: [] }]));
    if (r.fields.gpu2) assert.fail(k + ': invented gpu2 ' + r.fields.gpu2.value);
    if (r.fields.cpu) assert.ok(!/with\s+radeon/i.test(r.fields.cpu.value), k + ': cpu keeps the integrated-graphics tail');
  }
});
test('GPU repair is narrow: real Radeon names still read, junk names are dropped', () => {
  const g = t => J(T.scOcrParse([{ n: 1, text: 'Windows 11 Pro\nInstalled RAM 16.0 GB\n' + t, conf: 90, words: [] }])).fields.gpu1;
  assert.match(g('Graphics card AMD Radeon RX 6600 (8 GB)').value, /Radeon RX\s?6600/);
  assert.match(g('Graphics card AMD Radieon RX590 GME (8 GB)').value, /Radeon RX590/);
  assert.equal(g('Graphics card AMD Radeon Fixs30 GME'), null);
});

// ---- the screen finder, on real thumbnails and made-up pictures ----
const box = (g, w, h) => J(T.scBoxFromGray(g, w, h));
test('screen finder: a photo of a lit laptop screen returns the screen area (matches the prototype that was checked against real OCR)', () => {
  const t = THUMBS.angled_surface, b = box(new Uint8Array(Buffer.from(t.b64, 'base64')), t.w, t.h);
  assert.ok(b, 'a screen was found');
  assert.ok(Math.abs(b.x0 - 0.147) < 0.05 && Math.abs(b.y0 - 0.135) < 0.05 && Math.abs(b.x1 - 0.893) < 0.05 && Math.abs(b.y1 - 0.51) < 0.05, JSON.stringify(b));
});
test('screen finder: a photo of a computer case with no lit screen returns nothing', () => {
  const t = THUMBS.pc_case_no_screen;
  assert.equal(T.scBoxFromGray(new Uint8Array(Buffer.from(t.b64, 'base64')), t.w, t.h), null);
});
test('screen finder: never throws and returns nothing for empty, flat, tiny or full-frame input', () => {
  assert.equal(T.scBoxFromGray(null, 0, 0), null);
  assert.equal(T.scBoxFromGray(new Uint8Array(10), 3, 3), null);
  assert.equal(T.scBoxFromGray(new Uint8Array(200 * 150).fill(200), 200, 150), null, 'a flat picture');
  const g = new Uint8Array(200 * 150).fill(235); for (let i = 0; i < g.length; i += 7) g[i] = 40;   // a screenshot that fills the frame: bright with dark text
  assert.equal(T.scBoxFromGray(g, 200, 150), null, 'a screenshot filling the frame is not cropped');
});
test('screen finder: a bright block on a dark background is found, with its position', () => {
  const w = 200, h = 150, g = new Uint8Array(w * h).fill(25);
  for (let y = 40; y < 110; y++) for (let x = 50; x < 150; x++) g[y * w + x] = (x + y) % 9 === 0 ? 60 : 225;
  const b = box(g, w, h);
  assert.ok(b && b.x0 > 0.2 && b.x0 < 0.3 && b.x1 > 0.72 && b.x1 < 0.82 && b.y0 > 0.22 && b.y0 < 0.32 && b.y1 > 0.7 && b.y1 < 0.8, JSON.stringify(b));
});
