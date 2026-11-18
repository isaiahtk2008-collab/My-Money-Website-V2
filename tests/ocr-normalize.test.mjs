// Run with: node --test tests/ocr-normalize.test.mjs
// Loads the REAL scBuild + scNormalizeBuild out of index.html (fake data only) and proves the post-scan tidy-up for the Bought PC form:
//  - GPU 1 = integrated, GPU 2 = dedicated; a lone laptop dedicated GPU moves to GPU 2 and GPU 1 gets an "Integrated" tap chip (never auto-filled)
//  - storage loses "(shows N GB)"; screen becomes "<size>in, <hz>Hz"; a refresh rate with no size is only offered as a chip
//  - Notes keep battery lines only; a close model in the sheet is only ever a tap chip; the input is never mutated; other forms are untouched
//  - the feature flag exists and scApply falls back to the untouched result on any error
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.html'), 'utf8');
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
const fld = (k, extra = {}) => Object.assign({ k, l: k, t: 'text', o: [] }, extra);
const BY = {
  bpc: { t: 'Bought PC', kind: 'PC', f: ['Serial Number', 'PC model', 'Color', 'CPU (and specs)', 'GPU 1 (and specs)', 'GPU 2 (and specs)', 'RAM', 'Storage (SSD, HDD or NVME)', 'Screen Size, Hertz', 'Notes'].map(k => fld(k)) },
  bphone: { t: 'Bought phone', kind: 'Phone', f: ['Serial Number', 'Phone Model', 'Color', 'Storage (GB)', 'Notes'].map(k => fld(k)) }
};
const ctx = vm.createContext({ BY, unsold: () => [] });
vm.runInContext([
  constLine('scTxt'), constLine('scIdN'), fnBlock('scLuhn'), fnBlock('scMarketed'), 'const SC_SIZES=[16,32,64,128,256,512,1024,2048,4096];',
  parseBlock, fnBlock('scF'), fnBlock('scHas'), 'const SC_NOTE={battery:"Battery",software:"Software",storage:"Storage",display:"Display",cosmetic:"Cosmetic",included:"Included",other:"Other"};',
  constLine('SC_HIST_TAB'), constLine('SC_HIST_FIXED'), constLine('SC_HIST_VAR'), fnBlock('scHistory'), fnBlock('scBuild'), fnBlock('scNormalizeBuild'),
  'globalThis.__t={scBuild,scNormalizeBuild};'
].join('\n'), ctx);
const T = ctx.__t;
const J = x => JSON.parse(JSON.stringify(x));
const F = (v, conf = 'high', extra = {}) => Object.assign({ value: v, confidence: conf, evidence: String(v), image: 1 }, extra);
const scan = (fields, notes = []) => ({ deviceType: 'pc', accessoryType: null, fields, notes, conflicts: [] });
const N = (kind, text) => ({ kind, text, image: 1 });
const run = (fields, notes, raw) => { const r = scan(fields, notes); const b = T.scBuild('bpc', r, raw || null); return { b: J(b), o: J(T.scNormalizeBuild(b, 'bpc', r, raw || null)) }; };
const GPU1 = 'GPU 1 (and specs)', GPU2 = 'GPU 2 (and specs)', SCR = 'Screen Size, Hertz', STO = 'Storage (SSD, HDD or NVME)';

test('Example A: dedicated laptop GPU moves to GPU 2, GPU 1 stays blank with an Integrated chip, storage is 1TB, Hz is only a chip, Notes keep battery only', () => {
  const { b, o } = run(
    { model: F('ROG Zephyrus Mi GUB03ZM'), cpu: F('Intel Core i7-12700H'), gpu1: F('NVIDIA GeForce RTX 3060 Laptop GPU'), ram: F('16 GB'), storage: F('954 GB', 'high', { totalGB: 954 }) },
    [N('display', 'Resolution 2560 x 1600, 165 Hz'), N('software', 'Windows 11 Home'), N('battery', 'Battery health 90%')]);
  assert.equal(b.V[GPU1], 'NVIDIA GeForce RTX 3060 Laptop GPU', 'before: the dedicated GPU was in slot 1');
  assert.equal(b.V[STO], '1TB (shows 954 GB)');
  assert.equal(o.V[GPU1], undefined);
  assert.equal(o.V[GPU2], 'NVIDIA GeForce RTX 3060 Laptop GPU');
  assert.deepEqual(o.fix[GPU1].vals, ['Integrated']);
  assert.equal(o.V[STO], '1TB');
  assert.equal(o.V[SCR], undefined, 'screen is never invented when no size was seen');
  assert.deepEqual(o.fix[SCR].vals, ['165Hz']);
  assert.equal(o.V.Notes, 'Battery: Battery health 90%');
  assert.equal(o.V['PC model'], 'ROG Zephyrus Mi GUB03ZM', 'the raw model is kept');
  assert.equal(o.filled.find(x => x.k === STO).val, '1TB');
  assert.ok(!o.filled.some(x => x.k === GPU1), 'a blank field is not listed as filled');
});

test('integrated + dedicated in the wrong order are swapped into GPU 1 = integrated, GPU 2 = dedicated', () => {
  const { o } = run({ gpu1: F('NVIDIA GeForce RTX 3050 Laptop GPU'), gpu2: F('AMD Radeon Graphics') });
  assert.equal(o.V[GPU1], 'AMD Radeon Graphics');
  assert.equal(o.V[GPU2], 'NVIDIA GeForce RTX 3050 Laptop GPU');
  assert.equal(o.fix[GPU1], undefined, 'nothing to offer when the integrated GPU was seen');
});

test('a lone dedicated GPU that is not marked as a laptop GPU (a desktop) is left exactly as read', () => {
  const { b, o } = run({ gpu1: F('NVIDIA GeForce RTX 2060') });
  assert.equal(o.V[GPU1], b.V[GPU1]);
  assert.equal(o.V[GPU2], undefined);
  assert.equal(o.fix[GPU1], undefined);
});

test('screen: size and Hz together become "15.6in, 144Hz"; size alone keeps only the size and says so; nothing is invented', () => {
  let { o } = run({ screen: F('15.6-inch, 144Hz') });
  assert.equal(o.V[SCR], '15.6in, 144Hz');
  ({ o } = run({ screen: F('15.6-inch') }));
  assert.equal(o.V[SCR], '15.6in');
  assert.ok(o.checks.some(c => /refresh rate was not seen/i.test(c)));
  ({ o } = run({ screen: F('15.6-inch') }, [N('display', 'Resolution 1920 x 1080, 144 Hz')]));
  assert.equal(o.V[SCR], '15.6in, 144Hz', 'the Hz is taken from the Display note when the size is known');
  ({ o } = run({ cpu: F('Intel Core i5-11400H') }));
  assert.equal(o.V[SCR], undefined);
});

test('Notes: only battery lines survive; the payment line is kept; no battery and nothing else means no Notes at all', () => {
  let { o } = run({ cpu: F('Intel Core i5-11400H') }, [N('display', 'Resolution 1920 x 1080, 144 Hz'), N('cosmetic', 'scratch on lid'), N('other', 'Windows Device ID: ABC'), N('software', 'Windows 11')]);
  assert.equal(o.V.Notes, undefined);
  assert.ok(!o.filled.some(x => x.k === 'Notes'));
  ({ o } = run({ cpu: F('Intel Core i5-11400H') }, [N('battery', 'Cycle count 120'), N('storage', '200 GB used')]));
  assert.equal(o.V.Notes, 'Battery: Cycle count 120');
  const b = T.scBuild('bpc', scan({}, [N('display', 'x 60 Hz')]), null);
  b.noteLines.push('Paid by e-Transfer ($400)'); b.V.Notes = 'Display: x 60 Hz; Paid by e-Transfer ($400)';
  const r = J(T.scNormalizeBuild(b, 'bpc', scan({}), null));
  assert.equal(r.V.Notes, 'Paid by e-Transfer ($400)');
});

test('model chip: a near match to exactly one sheet model is only a tap chip (the raw model stays); exact, far or ambiguous matches offer nothing', () => {
  const rows = names => ({ BoughtPCs: { rows: names.map(n => ({ 'PC model': n })) } });
  const photo = { model: F('ROG Zephyrus Mi GUB03ZM') };
  let { o } = run(photo, [], rows(['ASUS ROG Zephyrus M16 (GU603ZM)', 'Dell G15 5511']));
  assert.deepEqual(o.fix['PC model'].vals, ['ASUS ROG Zephyrus M16 (GU603ZM)']);
  assert.equal(o.fix['PC model'].ow, true);
  assert.equal(o.V['PC model'], 'ROG Zephyrus Mi GUB03ZM');
  ({ o } = run(photo, [], rows(['ASUS ROG Zephyrus M16 (GU603ZM)', 'ASUS ROG Zephyrus M16 GU603ZM Gen 2'])));
  assert.equal(o.fix['PC model'], undefined, 'two candidates = ambiguous = nothing');
  ({ o } = run(photo, [], rows(['Dell G15 5511', 'ASUS ROG Zephyrus M16 (GU6032)'])));
  assert.equal(o.fix['PC model'], undefined, 'a sheet model that is 2 edits away (a typo in the sheet) is not offered');
  ({ o } = run({ model: F('Dell G15 5511') }, [], rows(['Dell G15 5511'])));
  assert.equal(o.fix['PC model'], undefined, 'an exact model needs no chip');
  ({ o } = run(photo, [], null));
  assert.equal(o.fix['PC model'], undefined, 'no sheet data = no chip');
});

test('the input is never mutated, other forms are returned untouched, and a bad input falls back to itself', () => {
  const r = scan({ gpu1: F('NVIDIA GeForce RTX 3060 Laptop GPU'), storage: F('954 GB', 'high', { totalGB: 954 }) });
  const b = T.scBuild('bpc', r, null), before = JSON.stringify(b);
  T.scNormalizeBuild(b, 'bpc', r, null);
  assert.equal(JSON.stringify(b), before);
  const ph = { V: { x: 1 }, filled: [] };
  assert.equal(T.scNormalizeBuild(ph, 'bphone', r, null), ph);
  assert.equal(T.scNormalizeBuild(null, 'bpc', r, null), null);
  const odd = { V: {}, filled: 'nope' };
  assert.equal(T.scNormalizeBuild(odd, 'bpc', r, null), odd);
});

test('feature flag exists (default ON, one line) and scApply guards the call so any error falls back to the plain scan result', () => {
  assert.match(html, /^const SC_NORMALIZE_ON=true;/m);
  assert.match(html, /b0=scBuild\(formId,res\);let b=b0;try\{if\(SC_NORMALIZE_ON\)b=scNormalizeBuild\(b0,formId,res\)\|\|b0\}catch\(e\)\{b=b0\}/);
  assert.equal([...html.matchAll(/scNormalizeBuild\(/g)].length, 2, 'defined once, called once (inside scApply)');
});
