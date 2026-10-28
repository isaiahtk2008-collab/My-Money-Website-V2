// Run with: node --test tests/trade-request.test.mjs
// Loads the REAL trade functions out of index.html (no copies) and proves:
//  - a Trade/Mixed sale becomes ONE request {action:'trade', id, soldTab, soldValues, boughtTab, boughtValues}
//  - an offline/failed trade is retried as that same single request with the same id, never split into two adds
//  - the Cash path posts exactly the same body as before
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.html'), 'utf8');

function fnBlock(name) {
  let start = html.indexOf('function ' + name + '(');
  if (start < 0) throw new Error(name + ' not found');
  if (html.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
  let i = html.indexOf('{', html.indexOf(')', start)), d = 0;
  for (; i < html.length; i++) {
    if (html[i] === '{') d++;
    else if (html[i] === '}') { d--; if (d === 0) return html.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces in ' + name);
}
function constLine(name) {
  const m = html.match(new RegExp('^const ' + name + '\\s*=.*$', 'm'));
  if (!m) throw new Error('const ' + name + ' not found');
  return m[0];
}

const formsStart = html.indexOf('const FORMS=[');
const byEndStr = 'const BY=Object.fromEntries(FORMS.map(f=>[f.id,f]));';
const byIdx = html.indexOf(byEndStr, formsStart);
if (formsStart < 0 || byIdx < 0) throw new Error('FORMS/BY not found');
const formsBlock = html.slice(formsStart, byIdx + byEndStr.length);
const payAssign = "['sphone','spc','sacc'].forEach(id=>{BY[id].pay=PAYF});";
if (html.indexOf(payAssign) < 0) throw new Error('pay assignment not found');

const store = {};
let fetchHandler = async () => ({ json: async () => ({ ok: true }) });
const sandbox = {
  store, $$: () => [], $: () => null, dayISO: () => '2026-10-27',
  LS: { get: k => store[k] || '', set: (k, v) => { store[k] = v; } },
  navigator: { onLine: true }, badge: () => {}, afterSend: () => {}, toast: () => {}, addOverlay: () => {},
  E: s => String(s), fetch: (...a) => fetchHandler(...a), console, TypeError
};
sandbox.J = (k, d) => { try { const v = JSON.parse(sandbox.LS.get(k)); return v == null ? d : v; } catch (e) { return d; } };
sandbox.W = (k, v) => sandbox.LS.set(k, JSON.stringify(v));
const ctx = vm.createContext(sandbox);

vm.runInContext([
  'var flushing=false; var V={}; var cur=null;',
  ...['F', 'YN', 'C6', 'PAYF', 'TR', 'RECVF', 'RECV_IDS', 'recvForm', 'recvPriceKey', 'recvFields', 'tradeOn', 'clean', 'numOf', 'uid', 'summ'].map(constLine),
  formsBlock, payAssign,
  ...['getVal', 'payload', 'buildTradeRequest', 'recvValues', 'recvSyncPrice', 'tradeItem', 'send', 'flush'].map(fnBlock),
  'globalThis.BY=BY; globalThis.PAYF=PAYF; globalThis.recvPriceKey=recvPriceKey; globalThis.recvFields=recvFields; globalThis.tradeOn=tradeOn;'
].join('\n;\n'), ctx);

const plain = x => JSON.parse(JSON.stringify(x));
function reset() {
  for (const k in store) delete store[k];
  ctx.V = {}; ctx.cur = null; ctx.flushing = false;
  fetchHandler = async () => ({ json: async () => ({ ok: true }) });
}
const URL_ = 'https://script.google.com/x';

test('buildTradeRequest returns exactly one trade request, no tab/values', () => {
  reset();
  const sv = { 'Device Label': 'iPhone 12' }, bv = { 'Serial Number': 'SN999' };
  const r = plain(ctx.buildTradeRequest('trade-123', ctx.BY.sphone, sv, ctx.BY.bpc, bv));
  assert.deepEqual(r, { action: 'trade', id: 'trade-123', soldTab: ctx.BY.sphone.tab, soldValues: sv, boughtTab: ctx.BY.bpc.tab, boughtValues: bv });
  assert.equal('tab' in r, false);
  assert.equal('values' in r, false);
});

test('recvPriceKey finds the price field (never Purchase Date)', () => {
  reset();
  assert.equal(ctx.recvPriceKey(ctx.BY.bphone), 'Purchased Price');
  assert.equal(ctx.recvPriceKey(ctx.BY.bpc), 'Purchase Price');
  assert.equal(ctx.recvPriceKey(ctx.BY.bacc), 'Purchase Price');
  assert.equal(ctx.recvPriceKey(null), null);
});

test('recvValues strips the tr: prefix and forces the price to Trade-In Value', () => {
  reset();
  Object.assign(ctx.V, { 'Received device type': 'PC', 'Trade-In Value': '450', 'tr:Serial Number': 'SN12345678', 'tr:PC model': 'ThinkPad', 'tr:Purchase Price': '1' });
  const r = plain(ctx.recvValues(ctx.BY.bpc));
  assert.equal(r['Serial Number'], 'SN12345678');
  assert.equal(r['PC model'], 'ThinkPad');
  assert.strictEqual(r['Purchase Price'], 450);
  assert.equal(Object.keys(r).some(k => k.startsWith('tr:')), false);
});

test('recvSyncPrice locks the price to Trade-In Value', () => {
  reset();
  Object.assign(ctx.V, { 'Received device type': 'Phone', 'Trade-In Value': '125.5' });
  ctx.recvSyncPrice();
  assert.equal(ctx.V['tr:Purchased Price'], '125.50');
  ctx.V['Trade-In Value'] = '';
  ctx.recvSyncPrice();
  assert.equal(ctx.V['tr:Purchased Price'], '');
});

test('received-device keys never collide with Sold form or Payment Type keys', () => {
  reset();
  const sold = new Set(ctx.PAYF.map(f => f.k));
  ['sphone', 'spc', 'sacc'].forEach(id => ctx.BY[id].f.forEach(f => sold.add(f.k)));
  ['bphone', 'bpc', 'bacc'].forEach(id => ctx.recvFields(ctx.BY[id]).forEach(f => assert.equal(sold.has(f.k), false, f.k)));
});

test('tradeOn only for Trade/Mixed on a Sold form', () => {
  reset();
  assert.equal(ctx.tradeOn(ctx.BY.sphone), false);
  ctx.V['Payment Type'] = 'Cash';
  assert.equal(ctx.tradeOn(ctx.BY.sphone), false);
  ctx.V['Payment Type'] = 'Trade';
  assert.equal(ctx.tradeOn(ctx.BY.bphone), false);
  assert.equal(ctx.tradeOn(ctx.BY.sphone), true);
  ctx.V['Payment Type'] = 'Mixed';
  assert.equal(ctx.tradeOn(ctx.BY.spc), true);
});

test('send: Cash body is byte-for-byte the old body; a trade posts ONE request', async () => {
  reset(); store.lgUrl = URL_;
  const rec = [];
  fetchHandler = async (url, opts) => { rec.push(opts.body); return { json: async () => ({ ok: true }) }; };
  await ctx.send({ id: 'a1', tab: 'Form Responses - Sold', values: { x: 1 } });
  assert.deepEqual(rec, [JSON.stringify({ secret: '', id: 'a1', tab: 'Form Responses - Sold', values: { x: 1 } })]);
  rec.length = 0;
  const req = ctx.buildTradeRequest('t1', ctx.BY.sphone, { a: 1 }, ctx.BY.bpc, { b: 2 });
  await ctx.send({ id: 't1', trade: 1, req });
  assert.deepEqual(rec, [JSON.stringify({ secret: '', action: 'trade', id: 't1', soldTab: ctx.BY.sphone.tab, soldValues: { a: 1 }, boughtTab: ctx.BY.bpc.tab, boughtValues: { b: 2 } })]);
});

test('offline retry keeps ONE trade with the SAME id and never splits it', async () => {
  reset(); store.lgUrl = URL_;
  const req = ctx.buildTradeRequest('T-ONE', ctx.BY.sphone, { a: 1 }, ctx.BY.bpc, { b: 2 });
  ctx.W('lg.q', [{ id: 'T-ONE', form: 'sphone', trade: 1, req, ts: 1 }]);
  const bodies = [];
  fetchHandler = async (url, opts) => { bodies.push(opts.body); throw new TypeError('Failed to fetch'); };
  await ctx.flush(true);
  let q = plain(ctx.J('lg.q', []));
  assert.equal(q.length, 1);
  assert.equal(q[0].id, 'T-ONE');
  assert.equal(q[0].req.action, 'trade');
  const before = bodies.length;
  fetchHandler = async (url, opts) => { bodies.push(opts.body); return { json: async () => ({ ok: true }) }; };
  await ctx.flush(true);
  assert.equal(ctx.J('lg.q', []).length, 0);
  const sent = bodies.slice(before);
  assert.equal(sent.length, 1);
  assert.equal(JSON.parse(sent[0]).action, 'trade');
  bodies.forEach(b => assert.equal('tab' in JSON.parse(b), false));
  assert.deepEqual([...new Set(bodies.map(b => JSON.parse(b).id))], ['T-ONE']);
});

test('a fatal script rejection keeps the unsplit trade in the queue', async () => {
  reset(); store.lgUrl = URL_;
  const req = ctx.buildTradeRequest('T-FATAL', ctx.BY.sphone, { a: 1 }, ctx.BY.bpc, { b: 2 });
  ctx.W('lg.q', [{ id: 'T-FATAL', form: 'sphone', trade: 1, req, ts: 1 }]);
  let calls = 0;
  fetchHandler = async () => { calls++; return { json: async () => ({ ok: false, error: 'tab not allowed: undefined' }) }; };
  await ctx.flush(true);
  const q = plain(ctx.J('lg.q', []));
  assert.equal(calls, 1);
  assert.equal(q.length, 1);
  assert.equal(q[0].req.action, 'trade');
  assert.equal(q[0].err, 'tab not allowed: undefined');
});

test('page script still compiles', () => {
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  let m, n = 0;
  while ((m = re.exec(html)) !== null) {
    if (!m[1].trim()) continue;
    assert.doesNotThrow(() => new vm.Script(m[1]), 'inline script block ' + n);
    n++;
  }
  assert.ok(n > 0);
});
