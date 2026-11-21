// Run with: node --test tests/assume-screen-charger.test.mjs
// Loads the REAL scAssumeScreen / scAssumeApply / scNormalizeBuild / getVal out of index.html (fake data only) and proves, for the Bought PC scan flow:
//  - laptops get the majority "<size>in, <hz>Hz" of past entries of the same model (2+ entries, 60%+ agreement) with a trailing *, in the form only
//  - no clear majority, one past entry, or no history = nothing is filled
//  - desktops / towers / mini PCs get screen N/A and Original Charger Yes; laptops never get a charger guess
//  - a value the photos read is never replaced; assumed (*) values are never counted as history
//  - the * is stripped when the entry is saved (getVal / payload); other fields are untouched
//  - the flag exists (default ON) and the call is guarded so any error leaves the scan result untouched
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
const PCF = ['Serial Number', 'PC model', 'Color', 'CPU (and specs)', 'GPU 1 (and specs)', 'GPU 2 (and specs)', 'RAM', 'Storage (SSD, HDD or NVME)', 'Screen Size, Hertz', 'Original Charger', 'Notes'];
const BY = { bpc: { t: 'Bought PC', kind: 'PC', f: PCF.map(k => fld(k)) } };
const ctx = vm.createContext({ BY, unsold: () => [], V: {} });
vm.runInContext([
  constLine('scTxt'), constLine('scIdN'), fnBlock('scLuhn'), fnBlock('scMarketed'), 'const SC_SIZES=[16,32,64,128,256,512,1024,2048,4096];',
  parseBlock, fnBlock('scF'), fnBlock('scHas'), 'const SC_NOTE={battery:"Battery",software:"Software",storage:"Storage",display:"Display",cosmetic:"Cosmetic",included:"Included",other:"Other"};',
  constLine('SC_HIST_TAB'), constLine('SC_HIST_FIXED'), constLine('SC_HIST_VAR'), fnBlock('scHistory'), fnBlock('scBuild'),
  constLine('SC_ASSUME_ON'), constLine('SC_PC_DESKTOP_RE'), constLine('SC_PC_LAPTOP_RE'), fnBlock('scAssumeScreen'), fnBlock('scAssumeApply'),
  fnBlock('scNormalizeBuild'), fnBlock('getVal'),
  'globalThis.__t={scBuild,scNormalizeBuild,scAssumeScreen,getVal};'
].join('\n'), ctx);
const T = ctx.__t;
const J = x => JSON.parse(JSON.stringify(x));
const F = (v, conf = 'high') => ({ value: v, confidence: conf, evidence: String(v), image: 1 });
const scan = (fields, notes = []) => ({ deviceType: 'pc', accessoryType: null, fields, notes, conflicts: [] });
const SCR = 'Screen Size, Hertz', CHG = 'Original Charger';
const rows = (...list) => ({ BoughtPCs: { rows: list.map(([m, s, c]) => ({ 'PC model': m, 'Screen Size, Hertz': s, 'CPU (and specs)': c || '' })) } });
const run = (fields, raw, notes) => { const r = scan(fields, notes); const b = T.scBuild('bpc', r, raw || null); return J(T.scNormalizeBuild(b, 'bpc', r, raw || null)); };
const SURF = 'Surface Laptop 4';

test('laptop: the majority of past entries of the same model is filled with a * and tagged as assumed', () => {
  const raw = rows(...Array(10).fill([SURF, '13.5in, 60Hz']), [SURF, '15in, 60Hz']);
  const o = run({ model: F(SURF) }, raw);
  assert.equal(o.V[SCR], '13.5in, 60Hz*');
  const e = o.filled.find(x => x.k === SCR);
  assert.match(e.assumed, /10 of 11 past entries/);
  assert.equal(o.V[CHG], undefined, 'a laptop never gets a charger guess');
});

test('no clear majority, a single past entry, or no history fills nothing', () => {
  assert.equal(run({ model: F(SURF) }, rows([SURF, '13.5in, 60Hz'], [SURF, '15in, 60Hz'])).V[SCR], undefined, '50/50');
  assert.equal(run({ model: F(SURF) }, rows([SURF, '13.5in, 60Hz'])).V[SCR], undefined, 'only 1 entry');
  assert.equal(run({ model: F(SURF) }, rows([SURF, '13.5in, 60Hz'], [SURF, '13.5in, 60Hz'], [SURF, '15in, 60Hz'], [SURF, '15in, 120Hz'])).V[SCR], undefined, '50% is under 60%');
  assert.equal(run({ model: F(SURF) }, null).V[SCR], undefined, 'no sheet data');
  assert.equal(run({ model: F(SURF) }, rows(['Other Model', '14in, 60Hz'], ['Other Model', '14in, 60Hz'])).V[SCR], undefined, 'other models do not count');
});

test('exactly 60% and exactly 2 entries are enough', () => {
  assert.equal(run({ model: F(SURF) }, rows([SURF, '13.5in, 60Hz'], [SURF, '13.5in, 60Hz'])).V[SCR], '13.5in, 60Hz*');
  const raw = rows(...Array(3).fill([SURF, '13.5in, 60Hz']), ...Array(2).fill([SURF, '15in, 60Hz']));
  assert.equal(run({ model: F(SURF) }, raw).V[SCR], '13.5in, 60Hz*');
});

test('same model with two CPUs: the entries with this CPU win when there are 2+ of them', () => {
  const raw = rows([SURF, '13.5in, 60Hz', 'i5-1145G7'], [SURF, '13.5in, 60Hz', 'i5-1145G7'], [SURF, '15in, 60Hz', 'i7-1185G7'], [SURF, '15in, 60Hz', 'i7-1185G7'], [SURF, '15in, 60Hz', 'i7-1185G7']);
  assert.equal(run({ model: F(SURF), cpu: F('i7-1185G7') }, raw).V[SCR], '15in, 60Hz*');
  assert.equal(run({ model: F(SURF), cpu: F('i5-1145G7') }, raw).V[SCR], '13.5in, 60Hz*');
});

test('assumed values are not history: a row ending in *, a partial entry and a bare size are ignored as votes', () => {
  const raw = rows([SURF, '13.5in, 60Hz*'], [SURF, '13.5in'], [SURF, ''], [SURF, '13.5in, 60Hz']);
  assert.equal(run({ model: F(SURF) }, raw).V[SCR], undefined, 'only 1 entry voted');
});

test('desktops, towers and mini PCs: screen N/A and charger Yes, from history or from the model name', () => {
  let o = run({ model: F('Dell OptiPlex 7090 Tower') }, null);
  assert.equal(o.V[SCR], 'N/A'); assert.equal(o.V[CHG], 'Yes');
  o = run({ model: F('Custom Gaming PC') }, rows(['Custom Gaming PC', 'N/A'], ['Custom Gaming PC', 'N/A']));
  assert.equal(o.V[SCR], 'N/A'); assert.equal(o.V[CHG], 'Yes');
  o = run({ model: F('Mac mini M2') }, null);
  assert.equal(o.V[SCR], 'N/A');
});

test('all-in-ones and tablets are treated like laptops (never N/A, no charger default)', () => {
  const o = run({ model: F('HP Pavilion All-in-One 24') }, null);
  assert.equal(o.V[SCR], undefined); assert.equal(o.V[CHG], undefined);
  const raw = rows(['iMac 24', '24in, 60Hz'], ['iMac 24', '24in, 60Hz']);
  assert.equal(run({ model: F('iMac 24') }, raw).V[SCR], '24in, 60Hz*');
});

test('unknown device type with no history fills nothing', () => {
  const o = run({ model: F('Zorblax 9000') }, null);
  assert.equal(o.V[SCR], undefined); assert.equal(o.V[CHG], undefined);
});

test('what the photos read is never replaced, and a screen tap chip already offered is left alone', () => {
  const raw = rows(...Array(3).fill([SURF, '13.5in, 60Hz']));
  assert.equal(run({ model: F(SURF), screen: F('15.6-inch, 144Hz') }, raw).V[SCR], '15.6in, 144Hz');
  assert.equal(run({ model: F(SURF), screen: F('120 Hz') }, raw).V[SCR], '120 Hz', 'a reading from the photos is kept as read, with no *');
  const split = rows(...Array(3).fill([SURF, '13.5in, 60Hz']), [SURF, '15in, 60Hz']);   /* not unanimous, so the older past-purchase fill stays out of it */
  const o = run({ model: F(SURF) }, split, [{ kind: 'display', text: 'Resolution 2560 x 1600, 165 Hz', image: 1 }]);
  assert.equal(o.V[SCR], undefined, 'a Hz-only chip already offered is not replaced by a guess');
  assert.deepEqual(o.fix[SCR].vals, ['165Hz']);
  const d = run({ model: F('Dell OptiPlex 7090 Tower'), chargerIncluded: { value: true, confidence: 'high', evidence: 'x', image: 1 } }, null);
  assert.equal(d.V[CHG], 'Yes');
  assert.equal(d.filled.find(x => x.k === CHG).assumed, undefined, 'a charger read from a photo is not relabelled as assumed');
});

test('the * is removed when the entry is saved, only for the screen field', () => {
  ctx.V = { [SCR]: '13.5in, 60Hz*', Notes: 'a*' };
  assert.equal(T.getVal({ k: SCR, t: 'text' }), '13.5in, 60Hz');
  assert.equal(T.getVal({ k: 'Notes', t: 'text' }), 'a*');
  ctx.V = { [SCR]: '  N/A ' };
  assert.equal(T.getVal({ k: SCR, t: 'text' }), 'N/A');
});

test('the input is never mutated, other forms are untouched, and a bad raw sheet falls back to the plain scan', () => {
  const r = scan({ model: F(SURF) }), raw = rows(...Array(3).fill([SURF, '13.5in, 60Hz'])), b = T.scBuild('bpc', r, raw), before = JSON.stringify(b);
  T.scNormalizeBuild(b, 'bpc', r, raw);
  assert.equal(JSON.stringify(b), before);
  for (const bad of [{ BoughtPCs: 5 }, { BoughtPCs: { rows: 'x' } }, { BoughtPCs: { rows: [null, 3, 'a'] } }]) assert.equal(run({ model: F(SURF) }, bad).V[SCR], undefined);
  const ph = { V: {}, filled: [] };
  assert.equal(T.scNormalizeBuild(ph, 'bphone', r, null), ph);
});

test('feature flag exists (default ON, one line) and the call is guarded', () => {
  assert.match(html, /^const SC_ASSUME_ON=true;/m);
  assert.match(html, /try\{if\(SC_ASSUME_ON&&typeof scAssumeApply==='function'\)\{const c=JSON\.parse\(JSON\.stringify\(o\)\);scAssumeApply\(c,K,rawIn\);Object\.assign\(o,c\)\}\}catch\(e\)\{\}/);
  assert.equal([...html.matchAll(/scAssumeApply\(/g)].length, 2, 'defined once, called once (inside scNormalizeBuild)');
});

test('a unanimous past entry (already filled by the older past-purchase feature) just gains the * and the "assumed" label, same value', () => {
  const o = run({ model: F(SURF) }, rows(...Array(3).fill([SURF, '13.5in, 60Hz'])));
  assert.equal(o.V[SCR], '13.5in, 60Hz*');
  assert.equal(o.filled.filter(x => x.k === SCR).length, 1, 'listed once');
});

test('reader memory ignores assumed entries (never learned from, never rewritten)', () => {
  assert.match(html, /scMemSuggest\(scMemGet\(\),b\.filled\.filter\(x=>!x\.assumed\)\)/);
  assert.match(html, /SC_LAST=\{t:Date\.now\(\),formId,filled:b\.filled\.filter\(x=>!x\.assumed\)\.map/);
});
