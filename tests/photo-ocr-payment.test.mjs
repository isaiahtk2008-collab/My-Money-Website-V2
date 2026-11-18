// Run with: node --test tests/photo-ocr-payment.test.mjs
// Proves the on-device reader (scOcrPay / scOcrParse), the AI+OCR merge (scMerge) and the form mapping (scBuild) understand
// bank-app e-Transfer "All set" screenshots: price paid, who it went to, date if printed. All names and emails below are fake.
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
  bphone: { t: 'Bought phone', kind: 'Phone', f: [fld('Serial Number'), fld('Phone Model'), fld('Purchased Price', { t: 'money' }), fld('Purchase Date', { t: 'date' }), fld('Bought From'), fld('Notes')] },
  sphone: { t: 'Sold phone', kind: 'Phone', f: [fld('Device Label', { t: 'item' }), fld('Sale Price', { t: 'money' }), fld('Sale Date', { t: 'date' }), fld("Buyer's Name"), fld('Notes')] },
  bpc: { t: 'Bought PC', kind: 'PC', f: [fld('Serial Number'), fld('PC model'), fld('Purchase Date', { t: 'date' }), fld('Purchase Price', { t: 'money' }), fld('Bought From'), fld('Notes')] }
};
const ctx = vm.createContext({ BY, unsold: () => [] });
vm.runInContext([
  constLine('scTxt'), constLine('scIdN'), fnBlock('scLuhn'), fnBlock('scMarketed'), 'const SC_SIZES=[16,32,64,128,256,512,1024,2048,4096];',
  parseBlock, fnBlock('scF'), 'const SC_NOTE={battery:"Battery",software:"Software",storage:"Storage",display:"Display",cosmetic:"Cosmetic",included:"Included",other:"Other"};',
  fnBlock('scBuild'),
  'globalThis.__t={scOcrPay,scOcrParse,scMerge,scBuild};'
].join('\n'), ctx);
const T = ctx.__t;
const J = x => JSON.parse(JSON.stringify(x));
const page = (text, extra = {}) => Object.assign({ n: 1, text, conf: 92, words: [] }, extra);

const SHOT_PERSON = `e-Transfer sent Undo
All set!
$400.00 CAD has been sent to JANE Q TESTER with Interac e-Transfer.
From Wealthsimple Chequing Chequing
To JANE Q TESTER
Email jane.tester@example.com Autodeposit enabled
Amount $400.00 CAD
Done`;
const SHOT_ITEM = `e-Transfer sent Undo
All set!
$450.00 CAD has been sent to MacBook Air M1 with Interac e-Transfer.
From Wealthsimple Chequing Chequing
To MacBook Air M1
Email seller.fake@example.com
Security question Password
Security answer 1234
Amount $450.00 CAD
Done`;

test('person screenshot: amount, name (tidied from ALL CAPS), direction; no date is invented', () => {
  const p = J(T.scOcrPay(SHOT_PERSON));
  assert.equal(p.amount, 400);
  assert.equal(p.party, 'Jane Q Tester');
  assert.equal(p.direction, 'sent');
  assert.equal(p.date, '');
  assert.equal(p.aAgree, true);
  assert.equal(p.pAgree, true);
});

test('item-name screenshot reads the amount and the name in the To row; security answer and email are never copied', () => {
  const r = J(T.scOcrParse([page(SHOT_ITEM)]));
  assert.equal(r.fields.payAmount.value, 450);
  assert.equal(r.fields.payAmount.confidence, 'high');
  assert.equal(r.fields.payParty.value, 'MacBook Air M1');
  const dump = JSON.stringify(r);
  assert.ok(!dump.includes('1234') && !dump.includes('example.com'), 'no email or security answer leaks out');
  assert.ok(!r.fields.serial && !r.fields.model, 'the To name is not mistaken for a device model or serial');
});

test('a printed date is read in ISO form; impossible dates are ignored', () => {
  assert.equal(T.scOcrPay(SHOT_PERSON + ' Nov 15, 2026').date, '2026-11-15');
  assert.equal(T.scOcrPay(SHOT_PERSON + ' 2026-11-15').date, '2026-11-15');
  assert.equal(T.scOcrPay(SHOT_PERSON + ' Feb 31, 2026').date, '');
});

test('not a payment: normal device text and a bare dollar sign are left alone', () => {
  assert.equal(T.scOcrPay('Serial number F4KLM2PQ0D Storage 256 GB'), null);
  assert.equal(T.scOcrPay('e-Transfer settings and help'), null);
});

test('two different amounts on one screenshot are never guessed between', () => {
  const p = J(T.scOcrPay(SHOT_PERSON.replace('Amount $400.00', 'Amount $350.00')));
  assert.equal(p.amount, null);
  assert.ok(p.conflicts.length === 1);
});

test('deposit + balance screenshots disagree: field left blank, both listed in notes', () => {
  const r = J(T.scOcrParse([page(SHOT_PERSON, { n: 1 }), page(SHOT_ITEM, { n: 2 })]));
  assert.equal(r.fields.payAmount, null);
  assert.ok(r.conflicts.some(c => /different amount/.test(c)));
  assert.ok(r.notes.length >= 2);
});

test('buy form: price, seller and a note are filled from a sent payment; date left alone with a check', () => {
  const res = J(T.scOcrParse([page(SHOT_PERSON)]));
  const b = J(T.scBuild('bphone', res));
  assert.equal(b.V['Purchased Price'], '400');
  assert.equal(b.V['Bought From'], 'Jane Q Tester');
  assert.ok(!('Purchase Date' in b.V));
  assert.ok(b.checks.some(c => /no date/.test(c)));
  assert.ok(/e-Transfer/.test(b.V.Notes || ''));
});

test('buy form with a printed date fills the date too', () => {
  const res = J(T.scOcrParse([page(SHOT_PERSON + ' Nov 15, 2026')]));
  const b = J(T.scBuild('bpc', res));
  assert.equal(b.V['Purchase Price'], '400');
  assert.equal(b.V['Purchase Date'], '2026-11-15');
});

test('sell form: money you SENT is never copied into a sale', () => {
  const res = J(T.scOcrParse([page(SHOT_PERSON)]));
  const s = J(T.scBuild('sphone', res));
  assert.ok(!('Sale Price' in s.V) && !("Buyer's Name" in s.V) && !('Sale Date' in s.V));
  assert.ok(s.checks.some(c => /SENT/.test(c)));
});

test('a payment with no "has been sent" line reads the amount only and has no direction', () => {
  const recv = `Interac e-Transfer\nAmount $620.00 CAD\nTo Me\n`;
  const p = J(T.scOcrPay(recv));
  assert.equal(p.amount, 620);
  assert.equal(p.direction, '');
});

test('smart read: AI and on-device agree -> high; disagree -> blank with a warning', () => {
  const ocr = J(T.scOcrParse([page(SHOT_PERSON)]));
  const ai = { deviceType: 'unknown', fields: { payAmount: { value: 400, confidence: 'high', evidence: '$400.00', image: 1 }, payParty: { value: 'Jane Q Tester', confidence: 'high', evidence: 'To', image: 1 } }, notes: [], conflicts: [] };
  const ok = J(T.scMerge(ai, ocr));
  assert.equal(ok.fields.payAmount.value, 400);
  assert.equal(ok.fields.payAmount.confidence, 'high');
  const bad = J(T.scMerge({ ...ai, fields: { payAmount: { value: 40, confidence: 'high', evidence: '$40', image: 1 } } }, ocr));
  assert.equal(bad.fields.payAmount, null);
  assert.ok(bad.conflicts.some(c => /disagree about the payment/.test(c)));
});
