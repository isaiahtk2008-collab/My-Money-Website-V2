// Run with: node --test tests/charger-label.test.mjs
// Loads the REAL scOcrCharger / scOcrParse / scBuild / scNormalizeBuild out of index.html (fake data only) and proves, for the Bought PC scan flow:
//  - a power adapter label read by the on-device reader (wall-socket INPUT + DC OUTPUT) is offered as a "Yes" TAP CHIP for Original Charger, never filled in
//  - a laptop's own regulatory label ("Rated: 15V 4A", no wall-socket range) is NOT mistaken for a charger
//  - nothing is offered when a charger answer already exists (desktop default, or read by the AI)
//  - the chip text never ends up in Notes; the flag exists (default ON) and the call is guarded; the chip tap also lights the Yes/No buttons
// The label texts below are what Tesseract really printed for fake test labels (the DC symbol comes out as a stray letter).
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
  constLine('SC_CHARGER_LABEL_ON'), fnBlock('scChargerChip'), fnBlock('scNormalizeBuild'),
  'globalThis.__t={scOcrCharger,scOcrParse,scBuild,scNormalizeBuild};'
].join('\n'), ctx);
const T = ctx.__t;
const J = x => JSON.parse(JSON.stringify(x));
const CHG = 'Original Charger';

// real Tesseract output for fake labels
const MAC = 'USB-C Power Adapter\nModel A1947\nINPUT: 100-240V ~ 50-60Hz 1.5A\nOUTPUT: 20.2V J 3A (61W)\nDesigned by Apple in California';
const WIN = 'AC ADAPTER Model ADP-65DW\nINPUT: 100-240V~ 1.6A 50/60Hz\nOUTPUT: 19.5V © 3.33A\nMade in China';
const LAPTOP_LABEL = 'Surface Laptop 4 Model 1950\nRated: 15V 4A\nFCC ID: C3K1950 IC: 3048A-1950\nSerial No. 0123 4567 8901';

test('detector: real adapter labels are recognised, with the volts and amps read', () => {
  assert.equal(T.scOcrCharger(MAC), '20.2V 3A');
  assert.equal(T.scOcrCharger(WIN), '19.5V 3.33A');
  assert.equal(T.scOcrCharger('INPUT 100-240V 50/60Hz 1.2A\nDC OUTPUT 20V--3.25A'), '20V 3.25A');
  assert.equal(T.scOcrCharger('Input: 100–240 V ~ 50-60 Hz\nOutput: 15V  4A'), '15V 4A', 'en dash and spacing');
});

test('detector: a laptop regulatory label, a spec screen and other text are NOT a charger', () => {
  assert.equal(T.scOcrCharger(LAPTOP_LABEL), null, 'a DC rating alone');
  assert.equal(T.scOcrCharger('INPUT: 100-240V ~ 50-60Hz 1.5A'), null, 'wall-socket input with no output');
  assert.equal(T.scOcrCharger('OUTPUT: 20V 3A'), null, 'output with no wall-socket input');
  assert.equal(T.scOcrCharger('INPUT 100-240V 50/60Hz\nOUTPUT: 230V 3A'), null, 'implausible output voltage');
  assert.equal(T.scOcrCharger('INPUT 100-240V 50/60Hz\nOUTPUT: 20V 90A'), null, 'implausible amps');
  assert.equal(T.scOcrCharger('Processor Intel(R) Core(TM) i5-1145G7\nInstalled RAM 16.0 GB\nSystem type 64-bit'), null);
  for (const bad of ['', null, undefined, 5, {}]) assert.equal(T.scOcrCharger(bad), null);
});

const aiF = (v, conf = 'high') => ({ value: v, confidence: conf, evidence: String(v), image: 1 });
function run(model, labelText, extraFields = {}) {
  const res = T.scOcrParse([{ n: 2, text: labelText, conf: 70, words: [] }]);
  res.deviceType = 'pc';
  res.fields = Object.assign({}, res.fields, { model: aiF(model) }, extraFields);
  const b = T.scBuild('bpc', res, null);
  return J(T.scNormalizeBuild(b, 'bpc', res, null));
}

test('adapter label in a photo (laptop): a Yes tap chip is offered and Original Charger stays empty', () => {
  const o = run('Surface Laptop 4', MAC);
  assert.equal(o.V[CHG], undefined, 'never auto-filled');
  assert.deepEqual(o.fix[CHG].vals, ['Yes']);
  assert.match(o.fix[CHG].why, /20\.2V 3A/);
  assert.match(o.fix[CHG].why, /photo 2/);
  assert.match(o.fix[CHG].why, /only if it came with this device/);
});

test('a laptop regulatory label offers nothing', () => {
  const o = run('Surface Laptop 4', LAPTOP_LABEL);
  assert.equal(o.V[CHG], undefined);
  assert.equal(o.fix && o.fix[CHG], undefined);
});

test('no chip when a charger answer already exists: desktop default Yes, or Yes read by the AI', () => {
  let o = run('Dell OptiPlex 7090 Tower', WIN);
  assert.equal(o.V[CHG], 'Yes');
  assert.equal(o.fix && o.fix[CHG], undefined, 'desktop already Yes');
  o = run('Surface Laptop 4', WIN, { chargerIncluded: { v: true, value: true, confidence: 'high', evidence: 'charger', image: 1 } });
  assert.equal(o.V[CHG], 'Yes', 'AI reading wins');
  assert.equal(o.fix && o.fix[CHG], undefined);
});

test('the chip text never reaches Notes, and other fields and chips are untouched', () => {
  const o = run('Surface Laptop 4', MAC);
  assert.ok(!/charger label|20\.2V/i.test(JSON.stringify(o.noteLines || [])), JSON.stringify(o.noteLines));
  assert.ok(!/charger label|20\.2V/i.test(String(o.V['Notes'] || '')), String(o.V['Notes']));
  const plain = run('Surface Laptop 4', 'Model A1947\nnothing else here');
  assert.equal(plain.fix[CHG], undefined);
});

test('the input is never mutated and bad input falls back to the plain scan', () => {
  const res = T.scOcrParse([{ n: 2, text: MAC, conf: 70, words: [] }]); res.deviceType = 'pc';
  const b = T.scBuild('bpc', res, null), before = JSON.stringify(b);
  T.scNormalizeBuild(b, 'bpc', res, null);
  assert.equal(JSON.stringify(b), before);
  for (const bad of [null, {}, { notes: 'x' }, { notes: [null, 3, { kind: 'charger' }] }]) {
    const o = J(T.scNormalizeBuild(T.scBuild('bpc', res, null), 'bpc', bad, null));
    assert.equal(o.fix && o.fix[CHG], undefined);
  }
  const ph = { V: {}, filled: [] };
  assert.equal(T.scNormalizeBuild(ph, 'bphone', res, null), ph, 'other forms untouched');
});

test('feature flag exists (default ON), the call is guarded, and the chip tap lights the Yes/No buttons', () => {
  assert.match(html, /^const SC_CHARGER_LABEL_ON=true;/m);
  assert.match(html, /try\{if\(SC_CHARGER_LABEL_ON&&typeof scChargerChip==='function'\)\{const c=JSON\.parse\(JSON\.stringify\(o\)\);scChargerChip\(c,res\);Object\.assign\(o,c\)\}\}catch\(e\)\{\}/);
  const fix = html.slice(html.indexOf("else if(a==='fix'){"), html.indexOf("else if(a==='fix'){") + 700);
  assert.match(fix, /data-lg="pick"/);
  assert.match(fix, /aria-pressed/);
});
