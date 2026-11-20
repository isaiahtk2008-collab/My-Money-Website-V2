// Photo reader v2: the pure parts (picture maths, serial voting, reading fusion, field voting, reader memory).
// These run without a browser. The browser-side pipeline is checked separately against real photos.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const line = n => html.match(new RegExp('^const ' + n + '=.*$', 'm'))[0];
function fn(name) {
  const s = html.indexOf('function ' + name + '(');
  assert.ok(s >= 0, name + ' missing');
  let i = html.indexOf('{', html.indexOf(')', s)), d = 0;
  for (;; i++) { if (html[i] === '{') d++; else if (html[i] === '}') { d--; if (!d) return html.slice(s, i + 1); } }
}
const block = (a, b) => { const i = html.indexOf(a), j = html.indexOf(b); assert.ok(i >= 0 && j > i, a); return html.slice(i, j); };
const ctx = vm.createContext({});
vm.runInContext([
  line('scTxt'), line('scIdN'), fn('scLuhn'), fn('scMarketed'),
  'const SC_SIZES=[16,32,64,128,256,512,1024,2048,4096];',
  block('/*OCR-PARSE-START*/', '/*OCR-PARSE-END*/'),
  block('/*OCR-PREP-START*/', '/*OCR-PREP-END*/'),
  block('/*OCR-MEM-START*/', '/*OCR-MEM-END*/'),
  'globalThis.__T={scSerialConsensus,scSerialConf,scSerialShape,scTiltDeg,scVariantGray,scOcrFuse,scOcrVoteFields,scOcrApplyVote,scCpuFixGen,scMemRecord,scMemSuggest,SC_MEM_NEW,scFoldId}',
].join('\n'), ctx);
const T = ctx.__T;

/* ---------- serial voting ---------- */
test('serial: readings that differ by one confusable letter vote to the majority character', () => {
  const c = T.scSerialConsensus([{ v: '0O1234567890', w: 1 }, { v: '001234567890', w: 1.5 }, { v: '001234567B90', w: 1 }]);
  assert.equal(c.value, '001234567890');
  assert.ok(c.fsupport >= 2.5);
});
test('serial: a Surface 12-digit serial is a known shape; a random short word is not', () => {
  assert.equal(T.scSerialShape('012345678901').known, true);
  assert.equal(T.scSerialShape('HELLO').ok, false);
  assert.equal(T.scSerialShape('ABCDEFGH').known, false);
});
test('serial: high confidence needs three exact agreeing weighted reads on a known shape', () => {
  const three = T.scSerialConsensus([{ v: '012345678901', w: 1 }, { v: '012345678901', w: 1 }, { v: '012345678901', w: 1.5 }]);
  assert.equal(T.scSerialConf(three), 'high');
  const two = T.scSerialConsensus([{ v: '012345678901', w: 1 }, { v: '012345678901', w: 1 }]);
  assert.equal(T.scSerialConf(two), 'medium');
  const one = T.scSerialConsensus([{ v: '012345678901', w: 1 }]);
  assert.equal(T.scSerialConf(one), 'low');
});
test('serial: totally different reads never get merged into a made-up serial', () => {
  const c = T.scSerialConsensus([{ v: '012345678901', w: 1 }, { v: '998877665544', w: 1 }]);
  assert.ok(['012345678901', '998877665544'].includes(c.value));
  assert.equal(T.scSerialConf(c), 'low');
});
test('serial: garbage input does not throw', () => {
  assert.equal(T.scSerialConsensus(null), null);
  assert.equal(T.scSerialConsensus([{ v: 'ab' }, null, {}]), null);
});

/* ---------- picture maths ---------- */
function stripes(angDeg) {
  const w = 400, h = 300, g = new Uint8Array(w * h).fill(230), a = angDeg * Math.PI / 180;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const yy = -x * Math.sin(a) + y * Math.cos(a);
    if (Math.floor(yy / 12) % 2 === 0 && x > 40 && x < 360) g[y * w + x] = 40;
  }
  return { g, w, h };
}
test('tilt: finds a 5 degree tilt, leaves level text alone', () => {
  const t = stripes(5), l = stripes(0);
  assert.ok(Math.abs(T.scTiltDeg(t.g, t.w, t.h) - 5) <= 1);
  assert.equal(T.scTiltDeg(l.g, l.w, l.h), 0);
});
test('tilt: blank and tiny pictures give 0', () => {
  assert.equal(T.scTiltDeg(new Uint8Array(100 * 100).fill(200), 100, 100), 0);
  assert.equal(T.scTiltDeg(new Uint8Array(10), 5, 2), 0);
});
test('variants: a glare gradient is flattened, text stays darker than its paper', () => {
  const w = 300, h = 100, g = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g[y * w + x] = 90 + Math.round(x * 0.5);   /* lighting ramps left to right */
  for (let y = 40; y < 60; y++) for (let x of [30, 31, 32, 33, 34, 250, 251, 252, 253, 254]) g[y * w + x] -= 60;
  const f = T.scVariantGray(g, w, h, 'flat');
  const paperL = f[10 * w + 20], paperR = f[10 * w + 270], inkL = f[50 * w + 32], inkR = f[50 * w + 252];
  assert.ok(Math.abs(paperL - paperR) < 25, 'paper level should match left and right after flattening');
  assert.ok(inkL < paperL - 40 && inkR < paperR - 40);
});
test('variants: binarising dark-mode text gives dark text on a white page', () => {
  const w = 200, h = 80, g = new Uint8Array(w * h).fill(25);
  for (let y = 30; y < 50; y++) for (let x = 60; x < 140; x++) if ((x + y) % 5 < 3) g[y * w + x] = 235;
  const b = T.scVariantGray(g, w, h, 'bin');
  let white = 0; for (const v of b) if (v === 255) white++;
  assert.ok(white > b.length * 0.7, 'background should end up white');
  assert.equal(b[40 * w + 61] === 0 || b[40 * w + 62] === 0 || b[40 * w + 63] === 0, true, 'ink should be black');
});

/* ---------- Intel generation repair ---------- */
test('cpu: a misread generation is repaired from the model number', () => {
  assert.equal(T.scCpuFixGen('41th Gen Intel Core i5-11400H'), '11th Gen Intel Core i5-11400H');
  assert.equal(T.scCpuFixGen('11th Gen Intel Core i5-1145G7'), '11th Gen Intel Core i5-1145G7');
  assert.equal(T.scCpuFixGen('8th Gen Intel Core i5-8250U'), '8th Gen Intel Core i5-8250U');
  assert.equal(T.scCpuFixGen('12th Gen Intel Core i7-12700H'), '12th Gen Intel Core i7-12700H');
  assert.equal(T.scCpuFixGen('AMD Ryzen 5 5600H'), 'AMD Ryzen 5 5600H');
  assert.equal(T.scCpuFixGen(null), '');
});

/* ---------- field voting ---------- */
const F = (value, confidence = 'medium') => ({ value, confidence });
test('vote: the majority value wins over a one-off misread', () => {
  const v = T.scOcrVoteFields([
    { fields: { cpu: F('41th Gen Intel Core i5-11400H') } },
    { fields: { cpu: F('11th Gen Intel Core i5-11400H') } },
    { fields: { cpu: F('11th Gen Intel Core i5-11400H') } },
  ]);
  assert.equal(v.cpu.field.value, '11th Gen Intel Core i5-11400H');
  assert.equal(v.cpu.votes, 3);
});
test('vote: a cut-off reading backs the longer value that contains it', () => {
  const v = T.scOcrVoteFields([
    { fields: { os: F('Windows 11') } }, { fields: { os: F('Windows 11') } }, { fields: { os: F('Windows 11') } },
    { fields: { os: F('Windows 11 Home') } }, { fields: { os: F('Windows 11 Home') } },
  ]);
  assert.equal(v.os.field.value, 'Windows 11 Home');
});
test('vote: the Rename button next to the model name is ignored', () => {
  const v = T.scOcrVoteFields([
    { fields: { model: F('Thin 11UC Rename') } }, { fields: { model: F('GF63 Thin 11UC') } }, { fields: { model: F('Thin 11UC') } },
  ]);
  assert.equal(v.model.field.value, 'GF63 Thin 11UC');
});
test('vote: serials and IMEIs are never voted on here', () => {
  const v = T.scOcrVoteFields([{ fields: { serial: F('111111111111') } }, { fields: { serial: F('111111111111') } }]);
  assert.equal(v.serial, undefined);
});
test('applyVote: fills a missing field, never overwrites without a clear majority, needs 2+ votes', () => {
  const vote = { ram: { field: F('16 GB'), votes: 3, n: '16gb', counts: { '16gb': 3 } }, gpu1: { field: F('RTX 3050'), votes: 1, n: 'rtx3050', counts: { rtx3050: 1 } } };
  const res = { fields: { ram: null, gpu1: null } };
  T.scOcrApplyVote(res, vote, 1);
  assert.equal(res.fields.ram.value, '16 GB');
  assert.equal(res.fields.gpu1, null);
  const res2 = { fields: { ram: { value: '8 GB', confidence: 'high', image: 1 } } };
  T.scOcrApplyVote(res2, { ram: { field: F('16 GB'), votes: 2, n: '16gb', counts: { '16gb': 2, '8gb': 2 } } }, 1);
  assert.equal(res2.fields.ram.value, '8 GB', 'a tie must keep what was already there');
});
test('applyVote: a value that came from a different photo is left alone', () => {
  const res = { fields: { ram: { value: '8 GB', confidence: 'high', image: 2 } } };
  T.scOcrApplyVote(res, { ram: { field: F('16 GB'), votes: 3, n: '16gb', counts: { '16gb': 3 } } }, 1);
  assert.equal(res.fields.ram.value, '8 GB');
});

/* ---------- fusing readings ---------- */
const SPEC = 'Processor Intel(R) Core(TM) i5-1145G7 @ 2.60GHz\nInstalled RAM 16.0 GB (15.6 GB usable)\nEdition Windows 11 Pro\n';
test('fuse: an extra reading adds a missing field but can never change a value already found', () => {
  const a = { text: 'Device name DESKTOP-ABC1234\n' + SPEC, conf: 80 };
  const bad = { text: 'Processor Intel(R) Core(TM) i7-9999X @ 3.00GHz\nSystem type 64-bit operating system\nInstalled RAM 4.00 GB\n', conf: 60 };
  const out = T.scOcrFuse([a, bad]);
  assert.ok(/1145G7/.test(out));
  assert.ok(!/9999X/.test(out), 'a conflicting reading must not be appended');
});
test('fuse: nothing readable returns an empty string, junk input does not throw', () => {
  assert.equal(T.scOcrFuse([]), '');
  assert.equal(T.scOcrFuse(null), '');
  assert.equal(T.scOcrFuse([{ text: '   ' }, null]), '');
});

/* ---------- reader memory ---------- */
const filled = (k, val) => ({ k, val });
test('memory: a corrected serial is remembered and fixed the same way next time, and never stored as a name', () => {
  let m = T.SC_MEM_NEW();
  m = T.scMemRecord(m, [filled('Serial Number', '0123456789O1')], { 'Serial Number': '012345678901' });
  assert.equal(Object.keys(m.vocab).length, 0);
  assert.equal(m.conf['O>0'], 1);
  const s = T.scMemSuggest(m, [filled('Serial Number', '0123456789O1')]);
  assert.equal(JSON.stringify(s.map(x => x.to)), '["012345678901"]');
});
test('memory: a name confirmed once is not snapped to, twice it is', () => {
  let m = T.SC_MEM_NEW();
  const ok = { 'PC model': 'Surface Laptop 4' };
  m = T.scMemRecord(m, [filled('PC model', 'Surface Laptop 4')], ok);
  assert.equal(T.scMemSuggest(m, [filled('PC model', 'Surface Laptop 41')]).length, 0);
  m = T.scMemRecord(m, [filled('PC model', 'Surface Laptop 4')], ok);
  const s = T.scMemSuggest(m, [filled('PC model', 'Surface Laptap 4')]);
  assert.equal(s[0].to, 'Surface Laptop 4');
});
test('memory: two equally close known names means no guess', () => {
  let m = T.SC_MEM_NEW();
  for (const n of ['Acer Nitro AN515-57', 'Acer Nitro AN515-58']) for (let i = 0; i < 2; i++) m = T.scMemRecord(m, [filled('PC model', n)], { 'PC model': n });
  assert.equal(T.scMemSuggest(m, [filled('PC model', 'Acer Nitro AN515-5X')]).length, 0);
});
test('memory: a completely different logged value is another entry, not a correction', () => {
  let m = T.SC_MEM_NEW();
  m = T.scMemRecord(m, [filled('PC model', 'Surface Laptop 4')], { 'PC model': 'MSI Katana GF66 11UC' });
  assert.equal(JSON.stringify(m.fix), '{}');
});
test('memory: a model name that is already known is never rewritten', () => {
  let m = T.SC_MEM_NEW();
  for (let i = 0; i < 3; i++) m = T.scMemRecord(m, [filled('CPU', 'Intel Core i5-1145G7')], { CPU: 'Intel Core i5-1145G7' });
  assert.equal(T.scMemSuggest(m, [filled('CPU', 'Intel Core i5-1145G7')]).length, 0);
});
test('memory: garbage in, nothing thrown', () => {
  assert.doesNotThrow(() => T.scMemRecord(null, null, null));
  assert.doesNotThrow(() => T.scMemRecord(T.SC_MEM_NEW(), [null, {}, { k: 'x' }], { x: undefined }));
  assert.equal(JSON.stringify(T.scMemSuggest(null, null)), '[]');
  assert.equal(JSON.stringify(T.scMemSuggest({ v: 2 }, [filled('CPU', 'x')])), '[]');
});
test('memory: it stays small', () => {
  let m = T.SC_MEM_NEW();
  for (let i = 0; i < 400; i++) m = T.scMemRecord(m, [filled('Serial Number', 'AAAAAAAA' + String(1000 + i))], { 'Serial Number': 'AAAAAAAB' + String(1000 + i) });
  assert.ok(Object.keys(m.fix).length <= 300);
});
