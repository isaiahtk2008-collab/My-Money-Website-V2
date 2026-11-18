// Run with: node --test tests/ocr-benchmark.test.mjs   (prints the accuracy table)
// Accuracy benchmark for the on-device reader (scOcrParse) on FAKE photo text in tests/fixtures/ocr-benchmark.json.
// Every expected field is scored: correct, wrong (filled with the wrong value) or blank. "wrong with high confidence" is the dangerous
// kind: it must stay at zero. An optional saved AI reading on a case ("ai") is scored the same way; with none, the AI column says n/a.
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
const BENCH = JSON.parse(fs.readFileSync(path.join(dir, 'tests', 'fixtures', 'ocr-benchmark.json'), 'utf8'));
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
vm.runInContext([constLine('scTxt'), constLine('scIdN'), fnBlock('scLuhn'), fnBlock('scMarketed'), 'const SC_SIZES=[16,32,64,128,256,512,1024,2048,4096];', parseBlock, 'globalThis.__t={scOcrParse,scLuhn,scMarketed};'].join('\n'), ctx);
const T = ctx.__t;
const J = x => JSON.parse(JSON.stringify(x));

// a valid fake IMEI: 14 digits + Luhn check digit
function fakeImei(body) { for (let c = 0; c < 10; c++) if (T.scLuhn(body + c)) return body + c; throw new Error('no luhn'); }
const IMEI = fakeImei('35432109876543');
// {IMEI_SLIP} = the same IMEI as a camera might misread it (0 as O, 1 as l): the reader should repair it, and the truth stays {IMEI}
const IMEI_SLIP = IMEI.replace(/0/g, 'O').replace(/1/g, 'l');
const sub = v => typeof v === 'string' ? v.replace(/\{IMEI_SLIP\}/g, IMEI_SLIP).replace(/\{IMEI\}/g, IMEI) : v;

const nrm = s => String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
const same = {
  serial: (v, e) => nrm(v) === nrm(e),
  imei: (v, e) => String(v).replace(/\D/g, '') === String(e).replace(/\D/g, ''),
  ram: (v, e) => parseInt(v, 10) === Number(e),
  screen: (v, e) => Math.round(parseFloat(v)) === Math.round(Number(e)),
  payAmount: (v, e) => Number(v) === Number(e),
  payParty: (v, e) => nrm(v) === nrm(e),
  payDirection: (v, e) => String(v) === String(e)
};
function isRight(key, x, e) {
  if (key === 'storage') { const t = Number(x.totalGB); const n = t > 0 ? (T.scMarketed(t) || t) : parseFloat(String(x.value)) * (/tb/i.test(String(x.value)) ? 1024 : 1); return n === Number(e); }
  if (same[key]) return same[key](x.value, e);
  return nrm(x.value).includes(nrm(e));   // model, cpu, os, gpu1: the truth must appear in what was read
}
function score(res, expect) {
  const rows = [];
  const f = (res && res.fields) || {};
  for (const [key, raw] of Object.entries(expect)) {
    const e = sub(raw), x = f[key] && f[key].value != null && f[key].value !== '' ? f[key] : null;
    let out;
    if (e === null) out = x ? 'wrong' : 'correct';
    else if (!x) out = 'blank';
    else out = isRight(key, x, e) ? 'correct' : 'wrong';
    rows.push({ key, out, conf: x ? x.confidence : null, got: x ? String(x.value) : '' });
  }
  return rows;
}
// a case is one photo ("text") or several ("pages": [text, text...]); "conf" is the reader's own score for the photo (default 92)
const run = c => T.scOcrParse((c.pages || [c.text]).map((t, i) => ({ n: i + 1, text: sub(t), conf: c.conf || 92, words: [] })));

test('benchmark: on-device reader accuracy on fake photo text', () => {
  const all = [], byCat = {}, byField = {};
  let aiRows = 0, aiRight = 0;
  for (const c of BENCH.cases) {
    const rows = score(J(run(c)), c.expect);
    rows.forEach(r => { r.id = c.id; r.cat = c.category; all.push(r); (byCat[c.category] = byCat[c.category] || []).push(r); (byField[r.key] = byField[r.key] || []).push(r); });
    if (c.ai) score(c.ai, c.expect).forEach(r => { aiRows++; if (r.out === 'correct') aiRight++; });
  }
  const pct = rs => rs.length ? Math.round(100 * rs.filter(r => r.out === 'correct').length / rs.length) : 0;
  const cnt = (rs, o) => rs.filter(r => r.out === o).length;
  const line = (name, rs) => name.padEnd(14) + String(rs.length).padStart(6) + String(cnt(rs, 'correct')).padStart(9) + String(cnt(rs, 'wrong')).padStart(7) + String(cnt(rs, 'blank')).padStart(7) + (pct(rs) + '%').padStart(8);
  const head = 'group'.padEnd(14) + 'fields'.padStart(6) + 'correct'.padStart(9) + 'wrong'.padStart(7) + 'blank'.padStart(7) + 'right'.padStart(8);
  const out = ['', 'ON-DEVICE READER (no AI), ' + BENCH.cases.length + ' fake cases', head, ...Object.keys(byCat).map(k => line(k, byCat[k])), '--', ...Object.keys(byField).map(k => line(k, byField[k])), '--', line('OVERALL', all)];
  const wrongHigh = all.filter(r => r.out === 'wrong' && r.conf === 'high');
  out.push('wrong AND marked high confidence: ' + wrongHigh.length + (wrongHigh.length ? ' -> ' + wrongHigh.map(r => r.id + '/' + r.key + '=' + r.got).join(', ') : ''));
  const misses = all.filter(r => r.out !== 'correct');
  if (misses.length) out.push('not correct: ' + misses.map(r => r.id + '/' + r.key + ' (' + r.out + (r.got ? ': ' + r.got : '') + ')').join('; '));
  out.push('AI reading: ' + (aiRows ? aiRight + ' of ' + aiRows + ' correct' : 'n/a (no saved AI readings in the fixture, and tests never call the real AI)'));
  console.log(out.join('\n'));
  assert.ok(pct(all) >= BENCH.floors.overall, 'overall accuracy ' + pct(all) + '% fell below the recorded floor ' + BENCH.floors.overall + '%');
  assert.ok(wrongHigh.length <= BENCH.floors.wrongHigh, 'a wrong value was marked high confidence');
});
