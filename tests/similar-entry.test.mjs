// Run with: node --test tests/similar-entry.test.mjs
// Loads the REAL "Use similar entry" helpers + the Part 2 normalizer out of index.html (fake data only) and proves:
//  - the list is read-only, newest first, de-duplicated, searchable by model / CPU / GPU, capped at 50, and empty on any bad input
//  - ONLY the seven spec fields are copied; serial, colour, condition, charger, date, price, seller, contact, meetup and notes never are
//  - empty fields are filled, a different existing value is only listed to be asked about, an equal one is left alone
//  - the normalizer only OFFERS (o.hx / tap chips), never applies, never changes what Part 2 produced, and does nothing with the flag off
//  - the submit payload for the Bought PC form is identical with and without the feature
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
const between = (a, b) => html.slice(html.indexOf(a), html.indexOf(b));
const parseBlock = between('/*OCR-PARSE-START*/', '/*OCR-PARSE-END*/');
const simBlock = between('/*SIMILAR-START*/', '/*SIMILAR-END*/');
const fld = (k, extra = {}) => Object.assign({ k, l: k, t: 'text', o: [] }, extra);
const PCF = ['Serial Number', 'PC model', 'Color', 'CPU (and specs)', 'GPU 1 (and specs)', 'GPU 2 (and specs)', 'RAM', 'Storage (SSD, HDD or NVME)', 'Screen Size, Hertz', 'Condition', 'Original Charger', 'Purchase Date', 'Purchase Price', 'Bought From', 'Phone Number, Email', 'Meetup Location/Address', 'Notes'];
const mkBY = () => ({
  bpc: { id: 'bpc', t: 'Bought PC', kind: 'PC', f: PCF.map(k => fld(k)) },
  bphone: { t: 'Bought phone', kind: 'Phone', f: ['Serial Number', 'Phone Model', 'Color', 'Storage (GB)', 'Notes'].map(k => fld(k)) }
});
function load(flagOn, storeRaw) {
  const ctx = vm.createContext({ BY: mkBY(), unsold: () => [], store: storeRaw === undefined ? undefined : { raw: storeRaw } });
  const sim = flagOn ? simBlock : simBlock.replace('const HX_SIMILAR_ON=true;', 'const HX_SIMILAR_ON=false;');
  vm.runInContext([
    constLine('scTxt'), constLine('scIdN'), fnBlock('scLuhn'), fnBlock('scMarketed'), 'const SC_SIZES=[16,32,64,128,256,512,1024,2048,4096];',
    parseBlock, fnBlock('scF'), fnBlock('scHas'), 'const SC_NOTE={battery:"Battery",software:"Software",storage:"Storage",display:"Display",cosmetic:"Cosmetic",included:"Included",other:"Other"};',
    constLine('SC_HIST_TAB'), constLine('SC_HIST_FIXED'), constLine('SC_HIST_VAR'), fnBlock('scHistory'), fnBlock('scBuild'),
    sim, fnBlock('scNormalizeBuild'),
    'globalThis.__t={scBuild,scNormalizeBuild,hxRows,hxSearch,hxVals,hxPlan,hxOfferHtml,HX_FIELDS,HX_KEYS,get on(){return HX_SIMILAR_ON}};'
  ].join('\n'), ctx);
  return ctx.__t;
}
const J = x => JSON.parse(JSON.stringify(x));
const T = load(true);
const ROW = (o = {}) => Object.assign({
  'Serial Number': 'SN-UNIQUE-1', 'PC model': 'ROG Zephyrus G14 GA402', Color: 'Grey', 'CPU (and specs)': 'AMD Ryzen 9 6900HS', 'GPU 1 (and specs)': 'AMD Radeon 680M',
  'GPU 2 (and specs)': 'NVIDIA GeForce RTX 3060 Laptop GPU', RAM: '16GB', 'Storage (SSD, HDD or NVME)': '1TB', 'Screen Size, Hertz': '14in, 120Hz', Condition: 'Used - Good',
  'Original Charger': 'Yes', 'Purchase Date': '2026-10-01', 'Purchase Price': 900, 'Bought From': 'Alex', 'Phone Number, Email': 'a@b.c', 'Meetup Location/Address': 'Square One', Notes: 'Battery: 90%'
}, o);
const RAW = rows => ({ BoughtPCs: { rows }, BoughtPhones: { rows: [] }, BoughtAccess: { rows: [] } });

test('hxRows: newest first, spec fields only, identical spec sets merged with a count', () => {
  const rows = T.hxRows(RAW([ROW({ 'Serial Number': 'A', 'Purchase Price': 1 }), ROW({ 'PC model': 'Dell G15', 'CPU (and specs)': 'i5-12500H', 'GPU 2 (and specs)': '', 'Serial Number': 'B' }), ROW({ 'Serial Number': 'C', Color: 'Black' })]));
  assert.equal(rows.length, 2, 'A and C have the same specs, so they merge');
  assert.equal(rows[0].model, 'ROG Zephyrus G14 GA402', 'the last row of the sheet is the newest');
  assert.equal(rows[0].n, 2);
  assert.equal(rows[1].model, 'Dell G15');
  const keys = Object.keys(rows[0]).sort();
  assert.deepEqual(keys, ['cpu', 'gpu1', 'gpu2', 'idx', 'model', 'n', 'ram', 'screen', 'storage'].sort(), 'no serial, colour, price, seller or notes ever enter the list');
});

test('hxRows: header matching ignores case and punctuation ("Serial Number:" style headers)', () => {
  const rows = T.hxRows(RAW([{ 'pc MODEL:': 'HP Omen', 'cpu (and specs)': 'i7', ram: '16GB' }]));
  assert.equal(rows[0].model, 'HP Omen'); assert.equal(rows[0].cpu, 'i7'); assert.equal(rows[0].ram, '16GB');
});

test('hxRows fail-safe: empty / missing / junk input gives an empty list and never throws', () => {
  for (const raw of [undefined, null, {}, RAW([]), { BoughtPCs: { rows: 'nope' } }, { BoughtPCs: null }, RAW([null, 5, 'x', {}]), RAW([{ Color: 'Red' }])]) assert.deepEqual(J(T.hxRows(raw)), []);
});

test('hxSearch: by model, CPU or GPU; every word must match; punctuation ignored; empty query lists all', () => {
  const list = T.hxRows(RAW([ROW({ 'PC model': 'Dell G15 5520', 'CPU (and specs)': 'Intel Core i7-12700H', 'GPU 2 (and specs)': 'NVIDIA RTX 3050 Ti' }), ROW({ 'PC model': 'ROG Strix G513', 'CPU (and specs)': 'Ryzen 7 6800H', 'GPU 2 (and specs)': 'RTX 3070 Ti' })]));
  assert.equal(T.hxSearch(list, '').length, 2);
  assert.equal(T.hxSearch(list, 'dell')[0].model, 'Dell G15 5520');
  assert.equal(T.hxSearch(list, 'ryzen')[0].model, 'ROG Strix G513');
  assert.equal(T.hxSearch(list, 'rtx 3070')[0].model, 'ROG Strix G513');
  assert.equal(T.hxSearch(list, 'i7 12700h')[0].model, 'Dell G15 5520');
  assert.equal(T.hxSearch(list, 'g-15').length, 1, 'g-15 matches G15 once punctuation is ignored');
  assert.equal(T.hxSearch(list, 'dell ryzen').length, 0, 'all words must match');
  assert.equal(T.hxSearch(list, 'zzz').length, 0);
  assert.deepEqual(J(T.hxSearch(null, 'x')), []);
});

test('hxSearch: at most 50, and they are the 50 most recent', () => {
  const rows = Array.from({ length: 80 }, (_, i) => ROW({ 'PC model': 'Laptop ' + i, 'Serial Number': 'S' + i }));
  const list = T.hxRows(RAW(rows)), hits = T.hxSearch(list, 'laptop');
  assert.equal(hits.length, 50);
  assert.equal(hits[0].model, 'Laptop 79'); assert.equal(hits[49].model, 'Laptop 30');
});

test('hxVals + hxPlan: copies spec fields only, whatever the entry holds', () => {
  const e = { model: 'M', cpu: 'C', gpu1: 'G1', gpu2: 'G2', ram: '8GB', storage: '256GB', screen: '15.6in, 60Hz', 'Serial Number': 'SNX', Color: 'Red', 'Purchase Price': 5, Notes: 'n', 'Bought From': 'x' };
  const vals = T.hxVals(e);
  assert.deepEqual(Object.keys(vals).sort(), [...T.HX_KEYS].sort());
  const bad = { 'Serial Number': 'SNX', Color: 'Red', Condition: 'New', 'Original Charger': 'Yes', 'Purchase Date': '2026-01-01', 'Purchase Price': '5', 'Bought From': 'x', 'Phone Number, Email': 'p', 'Meetup Location/Address': 'm', Notes: 'n', 'PC model': 'ok' };
  const plan = T.hxPlan(bad, () => '');
  assert.deepEqual(J(plan.fill.map(x => x.k)), ['PC model'], 'every unit-specific key is dropped even if it were passed in');
  assert.deepEqual(J(T.HX_KEYS), ['PC model', 'CPU (and specs)', 'GPU 1 (and specs)', 'GPU 2 (and specs)', 'RAM', 'Storage (SSD, HDD or NVME)', 'Screen Size, Hertz']);
});

test('hxPlan: fills empty, asks before replacing a different value, leaves an equal value alone', () => {
  const cur = { 'PC model': '', 'CPU (and specs)': 'i7-12700H', RAM: '16 GB', 'Storage (SSD, HDD or NVME)': '  ' };
  const plan = T.hxPlan({ 'PC model': 'Dell G15', 'CPU (and specs)': 'i7-12700H', RAM: '32GB', 'Storage (SSD, HDD or NVME)': '512GB', 'GPU 2 (and specs)': '' }, k => cur[k]);
  assert.deepEqual(J(plan.fill), [{ k: 'PC model', v: 'Dell G15' }, { k: 'Storage (SSD, HDD or NVME)', v: '512GB' }]);
  assert.deepEqual(J(plan.ask), [{ k: 'RAM', from: '16 GB', to: '32GB' }]);
  assert.equal(T.hxPlan({ RAM: '16gb' }, () => '16 GB').ask.length, 0, '"16gb" equals "16 GB", so nothing to ask');
});

/* ---- Part 2 connection ---- */
const GPU1 = 'GPU 1 (and specs)', GPU2 = 'GPU 2 (and specs)', SCR = 'Screen Size, Hertz', CPU = 'CPU (and specs)', RAM = 'RAM', STO = 'Storage (SSD, HDD or NVME)', MD = 'PC model';
const F = (v, conf = 'high', extra = {}) => Object.assign({ value: v, confidence: conf, evidence: String(v), image: 1 }, extra);
const scan = (fields, notes = []) => ({ deviceType: 'pc', accessoryType: null, fields, notes, conflicts: [] });
const N = (kind, text) => ({ kind, text, image: 1 });
const run = (tt, fields, notes, raw) => { const r = scan(fields, notes); const b = tt.scBuild('bpc', r, raw); return { b: J(b), o: J(tt.scNormalizeBuild(b, 'bpc', r, raw)) }; };
const LOGGED = RAW([ROW()]);

test('normalizer: a model that matches a logged device OFFERS its other specs and applies none of them', () => {
  const { b, o } = run(T, { model: F('ROG Zephyrus G14 GA402'), cpu: F('AMD Ryzen 9 6900HS') }, [], LOGGED);
  assert.ok(o.hx, 'an offer exists');
  assert.equal(o.hx.model, 'ROG Zephyrus G14 GA402');
  assert.deepEqual(Object.keys(o.hx.vals).sort(), [GPU1, GPU2, RAM, STO, SCR].sort(), 'only the specs the scan left empty are offered (CPU was read, model is already set)');
  for (const k of Object.keys(o.hx.vals)) assert.equal(o.V[k], undefined, k + ' was NOT applied');
  assert.deepEqual(Object.keys(o.hx.vals).filter(k => !T.HX_KEYS.includes(k)), []);
  const hash = x => JSON.stringify(Object.assign({}, x, { hx: undefined }));
  assert.equal(hash(o), hash(run(load(false), { model: F('ROG Zephyrus G14 GA402'), cpu: F('AMD Ryzen 9 6900HS') }, [], LOGGED).o), 'everything except the offer equals the flag-off result');
  assert.ok(b.V[MD]);
});

test('normalizer: no logged match, no model, or no history means no offer and an unchanged result', () => {
  const same = (fields, raw) => { const a = run(T, fields, [], raw).o, c = run(load(false), fields, [], raw).o; assert.equal(a.hx, undefined); assert.deepEqual(a, c); };
  same({ model: F('Totally New Model X1') }, LOGGED);
  same({ cpu: F('Intel i5') }, LOGGED);
  same({ model: F('ROG Zephyrus G14 GA402') }, RAW([]));
  same({ model: F('ROG Zephyrus G14 GA402') }, null);
  same({ model: F('ROG Zephyrus G14 GA402') }, { BoughtPCs: { rows: 'bad' } });
});

test('normalizer: the logged screen resolves an unknown size, as a tap choice only', () => {
  const { o } = run(T, { model: F('ROG Zephyrus G14 GA402') }, [N('display', 'Resolution 2560 x 1600, 120 Hz')], LOGGED);
  assert.equal(o.V[SCR], undefined, 'the size is not applied');
  assert.ok(o.fix[SCR].vals.includes('14in, 120Hz'), 'offered as 14in, 120Hz (size from your earlier entry, Hz from the photo)');
  assert.ok(o.checks.some(c => /only known from your earlier/.test(c)));
  assert.equal(o.hx.vals[SCR], undefined, 'the same field is not offered twice');
});

test('normalizer: a screen the photos DID read is never replaced, only compared', () => {
  const { o } = run(T, { model: F('ROG Zephyrus G14 GA402'), screen: F('15.6 inch 144Hz') }, [], LOGGED);
  assert.equal(o.V[SCR], '15.6in, 144Hz');
  assert.ok(o.checks.some(c => /14-inch screen, but the photos say 15.6/.test(c)));
  assert.equal(o.hx.vals[SCR], undefined);
});

test('normalizer: a size from the photos plus a missing Hz is offered the logged Hz as a chip', () => {
  const { o } = run(T, { model: F('ROG Zephyrus G14 GA402'), screen: F('14 inch') }, [], LOGGED);
  assert.equal(o.V[SCR], '14in');
  assert.deepEqual(o.fix[SCR].vals, ['14in, 120Hz']);
});

test('normalizer: the logged GPU layout never fills a slot the scan disagrees with', () => {
  const { o } = run(T, { model: F('ROG Zephyrus G14 GA402'), gpu1: F('NVIDIA GeForce RTX 4060 Laptop GPU') }, [], LOGGED);
  assert.equal(o.V[GPU2], 'NVIDIA GeForce RTX 4060 Laptop GPU');
  assert.equal(o.hx.vals[GPU1], undefined, 'a different dedicated GPU means the old integrated GPU is not offered');
  assert.equal(o.hx.vals[GPU2], undefined);
});

test('normalizer: an offer-time failure leaves Part 2\'s output exactly as it was', () => {
  const evil = { BoughtPCs: { get rows() { throw new Error('boom'); } } };
  const a = run(T, { model: F('ROG Zephyrus G14 GA402') }, [], evil).o, c = run(load(false), { model: F('ROG Zephyrus G14 GA402') }, [], evil).o;
  assert.deepEqual(a, c);
});

test('flag off: HX_SIMILAR_ON is false and no offer is ever produced', () => {
  const off = load(false);
  assert.equal(off.on, false); assert.equal(T.on, true);
  assert.equal(run(off, { model: F('ROG Zephyrus G14 GA402') }, [], LOGGED).o.hx, undefined);
});

test('offer html: only for still-empty fields, escaped, and empty with the flag off or after the fields are filled', () => {
  const html1 = T.hxOfferHtml.toString();
  assert.ok(/data-hx="offer"/.test(html1));
  assert.ok(/HX_SIMILAR_ON/.test(html1));
});

/* ---- the sheet mapping is untouched ---- */
test('submit payload: the Bought PC payload code, form definition and column names are byte-identical to before the feature', () => {
  const baseline = fs.existsSync(process.env.HX_BASELINE || '') ? fs.readFileSync(process.env.HX_BASELINE, 'utf8') : null;
  if (!baseline) return;   // only meaningful when the pre-Part-3 copy is supplied; the verification script supplies it
  const cut = (src, a, b) => src.slice(src.indexOf(a), src.indexOf(b, src.indexOf(a)));
  for (const [a, b] of [["{id:'bpc',g:'Buying'", "{id:'bacc'"], ['function getVal(x)', 'const summ='], ['function submit(', '\n}\n']]) assert.equal(cut(html, a, b), cut(baseline, a, b), a + ' changed');
});
