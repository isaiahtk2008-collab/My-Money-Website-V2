// Run with: node tests/insights.test.mjs
// Loads the REAL helpers, stats functions and insights library out of index.html (no copies), then checks:
// library size, every insight never throws, text is safe, rotation is deterministic and yields 4-8 per day,
// every insight eventually appears, nothing mutates the data, and the original 6 insights still match.
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, '..', 'index.html'), 'utf8');

/* ---------- pull real code out of index.html ---------- */
function constLine(name) {
  const m = html.match(new RegExp('^const ' + name + '=.*$', 'm'));
  if (!m) throw new Error('const ' + name + ' not found in index.html');
  return m[0];
}
function fnBlock(name) {
  const start = html.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('function ' + name + ' not found in index.html');
  let i = html.indexOf('{', html.indexOf(')', start)), depth = 0;
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (depth === 0) return html.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces in ' + name);
}
const consts = ['esc', 'nf0', 'nf2', 'mny', 'sgn', 'SM', 'pct', 'MO', 'DOW', 'DAY', 'sod', 'addD', 'diffD', 'fd', 'dkey', 'sum', 'avg', 'median', 'groupBy', 'plural', 'kindWord', 'inR'].map(constLine);
const funcs = ['spendRows', 'tally', 'bucketsFor', 'autoGran', 'spendingStats', 'soldItems', 'resellingStats', 'inventoryStats', 'investingStats', 'insightsLegacy'].map(n => {
  // insightsLegacy is the old function kept as a fallback
  return fnBlock(n);
});
const bm = html.match(/\/\* INSIGHTS-LIB:START[\s\S]*?\/\* INSIGHTS-LIB:END \*\//);
if (!bm) throw new Error('INSIGHTS-LIB markers not found in index.html');

const ctx = vm.createContext({ console, Intl, Math, Date, Set, Map, Array, Object, JSON, Number, String, RegExp, setInterval: () => 0, document: { hidden: false } });
vm.runInContext(
  [...consts, ...funcs, bm[0], 'globalThis.__t={INSIGHT_LIB,INSIGHT_ORDER,insightCtx,insightPool,pickInsights,insights,insightsLegacy,insightQuota,insightDayNum,insightCursor,spendingStats,resellingStats,inventoryStats,investingStats,addD,sod,esc};'].join('\n'),
  ctx
);
const T = ctx.__t;

/* ---------- tiny harness ---------- */
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + String(e.message).split('\n')[0]); }
}

/* ---------- synthetic data ---------- */
function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const NOW = new Date(2026, 9, 22); // Oct 22 2026, local midnight

function makeData({ seed = 1, evil = false, staleInvest = false, empty = false, sparse = false, skew = false } = {}) {
  const r = rng(seed), pick = a => a[Math.floor(r() * a.length)];
  const D = { expenses: [], items: [], investments: [], issues: [] };
  if (empty) return D;
  const evilName = '<img src=x onerror=alert(1)>';
  const places = ['Costco', 'Tim Hortons', 'Amazon', 'Shell', 'Walmart', evil ? evilName : 'Netflix'];
  const cats = ['Food', 'Transportation', 'Shopping', 'Other', 'Subscriptions'];
  const pays = ['Visa', 'Debit', 'Cash'];
  const days = sparse ? 6 : 130;
  let id = 0;
  for (let d = 0; d < days; d++) {
    const n = sparse ? 1 : 1 + Math.floor(r() * 3);
    for (let k = 0; k < n; k++) {
      const amt = r() < 0.35 ? +(2 + r() * 7).toFixed(2) : +(10 + r() * (d < 30 ? 90 : 55)).toFixed(2);
      const date = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - d);
      D.expenses.push({ id: 'e' + (id++), date, amount: amt, category: pick(cats), item: r() < 0.3 ? 'Coffee' : (evil ? evilName : 'Thing ' + Math.floor(r() * 9)),
        place: r() < 0.12 ? null : pick(places), payment: pick(pays), tag: r() < 0.5 ? 'Business' : 'Personal', notes: null, isRefund: false });
    }
  }
  if (!sparse) {
    D.expenses.push({ id: 'er1', date: new Date(2026, 9, 15), amount: -30, category: 'Shopping', item: 'Return', place: 'Amazon', payment: 'Visa', tag: 'Personal', notes: null, isRefund: true });
    D.expenses.push({ id: 'big', date: new Date(2026, 9, 10), amount: 640, category: 'Shopping', item: evil ? evilName : 'Monitor', place: 'Costco', payment: 'Visa', tag: 'Business', notes: null, isRefund: false });
  }
  const kinds = ['Phone', 'PC', 'Accessory'], sellers = evil ? [evilName, 'Kijiji'] : ['Marketplace', 'Kijiji', 'eBay'], conds = ['New', 'Used - Good', 'Used - Fair'];
  const nItems = sparse ? 2 : 34;
  for (let i = 0; i < nItems; i++) {
    const kind = kinds[i % 3], buyPrice = 40 + Math.floor(r() * 400);
    const sold = i % 4 !== 0 || i < 4;
    const buyAge = 5 + Math.floor(r() * 150);
    const buyDate = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - buyAge);
    const it = { id: 'i' + i, name: (evil && i === 1 ? evilName : kind + ' model ' + (i % 6)), kind, buyPrice, buyDate, seller: sellers[i % sellers.length], condition: conds[i % 3], sold, sellPrice: null, sellDate: null, buyer: null, profit: null, roi: null, days: null, age: null };
    if (sold) {
      const hold = Math.min(buyAge - 1, 2 + Math.floor(r() * 40) + (i % 3) * (i < 18 ? 10 : 2));
      const loss = i % 7 === 0;
      it.sellPrice = loss ? Math.round(buyPrice * 0.8) : Math.round(buyPrice * (1.1 + r() * 0.5));
      it.sellDate = new Date(buyDate.getFullYear(), buyDate.getMonth(), buyDate.getDate() + hold);
      it.buyer = i % 5 === 0 ? null : 'Buyer ' + i;
      it.profit = it.sellPrice - buyPrice; it.roi = it.profit / buyPrice; it.days = hold;
    } else { it.age = buyAge; }
    D.items.push(it);
  }
  if (skew) {
    // a seller that keeps losing money, and a stock pile dominated by phones
    for (let i = 0; i < 3; i++) {
      const buyDate = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - 20), sellDate = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - 4 - i);
      D.items.push({ id: 'loss' + i, name: 'Phone loss ' + i, kind: 'Phone', buyPrice: 300, buyDate, seller: 'LossCo', condition: 'Used - Fair', sold: true, sellPrice: 220, sellDate, buyer: 'B' + i, profit: -80, roi: -80 / 300, days: 16 - i, age: null });
    }
    for (let i = 0; i < 8; i++) D.items.push({ id: 'ph' + i, name: 'Phone stock ' + i, kind: 'Phone', buyPrice: 150 + i, buyDate: new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - 3 - i), seller: 'Kijiji', condition: 'New', sold: false, sellPrice: null, sellDate: null, buyer: null, profit: null, roi: null, days: null, age: 3 + i });
  }
  const ports = ['TFSA', 'RRSP', 'Crypto'];
  ports.forEach((p, pi) => {
    let flow = 0;
    for (let m = 5; m >= 0; m--) {
      const f = 200 + pi * 50; flow += f;
      const value = p === 'Crypto' ? flow * (0.7 + m * 0.01) : flow * (1.04 + (5 - m) * 0.005) * (pi === 0 ? 3 : 1);
      const back = (staleInvest ? 20 : 0) + m * 30;
      D.investments.push({ id: 'v' + pi + m, portfolio: p, date: new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - back), value, flow: f });
    }
  });
  D.issues.push({ sev: 'warn', sheet: 'Expenses', rows: [1, 2, 3] });
  return D;
}
function rangeOf(len) {
  const start = T.addD(NOW, -(len - 1));
  return { start, end: NOW, len, pStart: T.addD(start, -len), pEnd: T.addD(start, -1) };
}
function build(opts, len = 30) {
  const D = makeData(opts), R = rangeOf(len);
  const ss = T.spendingStats(D, R, {}, 'week'), rs = T.resellingStats(D, R, 'All');
  return { D, R, ss, rs, c: T.insightCtx(D, R, ss, rs, NOW) };
}
const variants = {
  rich30: build({ seed: 1 }, 30),
  rich120: build({ seed: 2 }, 120),
  rich90: build({ seed: 5 }, 90),
  stale: build({ seed: 3, staleInvest: true }, 45),
  sparse: build({ seed: 4, sparse: true }, 30),
  empty: build({ empty: true }, 30),
  evil: build({ seed: 6, evil: true }, 60),
  skew: build({ seed: 7, skew: true }, 60)
};

/* ---------- tests ---------- */
console.log('Insights library');

test('library has exactly 60 insights with unique ids', () => {
  assert.equal(T.INSIGHT_LIB.length, 60);
  assert.equal(new Set(T.INSIGHT_LIB.map(d => d.id)).size, 60);
  assert.equal(T.INSIGHT_ORDER.length, 60);
  T.INSIGHT_LIB.forEach(d => { assert.equal(typeof d.run, 'function', d.id); assert.ok(d.cat, d.id + ' has no category'); });
});

test('no insight ever throws, on any data shape (rich, sparse, empty, hostile)', () => {
  for (const [name, v] of Object.entries(variants)) {
    T.INSIGHT_LIB.forEach(d => { try { d.run(v.c); } catch (e) { throw new Error(d.id + ' threw on ' + name + ': ' + e.message); } });
  }
});

test('every returned insight is well formed and text is clean', () => {
  for (const [name, v] of Object.entries(variants)) {
    for (const it of T.insightPool(v.c).values()) {
      assert.ok(typeof it.t === 'string' && it.t.length > 8, it._k + ' text on ' + name);
      assert.ok(!/NaN|undefined|Infinity|\bnull\b/.test(it.t), it._k + ' bad text: ' + it.t);
      assert.ok(['goto', 'open'].includes(it.act), it._k);
      assert.ok(['spending', 'reselling', 'inventory', 'investing', 'data'].includes(it.v), it._k + ' view ' + it.v);
      assert.ok(['spend', 'clock', 'up', 'down', 'user', 'alert', 'bulb', 'tag', 'cart', 'invest'].includes(it.i), it._k + ' icon');
      if (it.act === 'open') assert.ok(it.id, it._k + ' open without id');
    }
  }
});

test('user-supplied text is escaped (no raw HTML from the sheet)', () => {
  const pool = T.insightPool(variants.evil.c);
  let sawEscaped = false;
  for (const it of pool.values()) {
    const stripped = it.t.replace(/<\/?b>/g, '').replace(/<span class="amt">|<\/span>/g, '');
    assert.ok(!/[<>]/.test(stripped), it._k + ' leaks raw HTML: ' + it.t);
    if (it.t.includes('&lt;img')) sawEscaped = true;
  }
  assert.ok(sawEscaped, 'expected at least one insight to show the escaped hostile name');
});

test('across data scenarios all 60 insights can fire', () => {
  const fired = new Set();
  for (const v of Object.values(variants)) for (const k of T.insightPool(v.c).keys()) fired.add(k);
  const missing = T.INSIGHT_LIB.map(d => d.id).filter(id => !fired.has(id));
  assert.equal(missing.length, 0, 'never fired: ' + missing.join(','));
});

test('insights do not mutate the data or the stats', () => {
  const v = variants.rich30, snap = () => JSON.stringify({ D: v.D, ss: v.ss, rs: v.rs });
  const before = snap();
  T.insightPool(v.c); T.insights(v.D, v.R, v.ss, v.rs);
  assert.equal(snap(), before);
});

test('original 6 insights still produce identical text', () => {
  const legacy = T.insightsLegacy(variants.rich30.D, variants.rich30.R, variants.rich30.ss, variants.rich30.rs);
  assert.ok(legacy.length > 0);
  const lib = T.insightPool(variants.rich30.c);
  const libTexts = new Set([...lib.values()].map(x => x.t));
  legacy.forEach(l => assert.ok(libTexts.has(l.t), 'legacy insight missing from library: ' + l.t));
});

console.log('Daily rotation');
const day = k => new Date(2026, 9, 22 + k);
const poolRich = T.insightPool(variants.rich90.c);

test('rich data gives a pool big enough for the rotation (at least 30 eligible)', () => {
  assert.ok(poolRich.size >= 30, 'pool size ' + poolRich.size);
  console.log('       eligible insights with the rich test data: ' + poolRich.size + ' of 60');
});

test('every day shows between 4 and 8 insights (400 consecutive days)', () => {
  const counts = {};
  for (let k = 0; k < 400; k++) {
    const n = T.pickInsights(poolRich, day(k)).length;
    assert.ok(n >= 4 && n <= 8, 'day +' + k + ' showed ' + n);
    counts[n] = (counts[n] || 0) + 1;
  }
  assert.ok(Object.keys(counts).length >= 4, 'quota barely varies: ' + JSON.stringify(counts));
  console.log('       insights per day over 400 days: ' + JSON.stringify(counts));
});

test('same date always gives the same insights, at any time of day', () => {
  const a = T.pickInsights(poolRich, new Date(2026, 10, 3, 0, 0, 1)).map(x => x._k);
  const b = T.pickInsights(poolRich, new Date(2026, 10, 3, 23, 59, 59)).map(x => x._k);
  const c2 = T.pickInsights(T.insightPool(variants.rich90.c), new Date(2026, 10, 3, 12)).map(x => x._k);
  assert.deepEqual(a, b); assert.deepEqual(a, c2);
});

test('the set changes from one day to the next', () => {
  let same = 0;
  for (let k = 0; k < 200; k++) {
    const a = T.pickInsights(poolRich, day(k)).map(x => x._k).join(), b = T.pickInsights(poolRich, day(k + 1)).map(x => x._k).join();
    if (a === b) same++;
  }
  assert.equal(same, 0, same + ' consecutive days were identical');
});

test('no insight goes unseen for more than 14 days (600-day simulation)', () => {
  const last = {}, worst = {};
  for (let k = 0; k < 600; k++) {
    const shown = new Set(T.pickInsights(poolRich, day(k)).map(x => x._k));
    for (const id of poolRich.keys()) { if (shown.has(id)) last[id] = k; else worst[id] = Math.max(worst[id] || 0, k - (last[id] ?? -1)); }
  }
  const [id, gap] = Object.entries(worst).sort((a, b) => b[1] - a[1])[0];
  assert.ok(gap <= 14, id + ' went unseen for ' + gap + ' days');
  console.log('       longest an eligible insight stayed hidden: ' + gap + ' days');
});

test('topics are mixed each day (at most 3 from one category, at most 1 tip)', () => {
  for (let k = 0; k < 400; k++) {
    const per = {};
    T.pickInsights(poolRich, day(k)).forEach(x => per[x._cat] = (per[x._cat] || 0) + 1);
    assert.ok((per.tips || 0) <= 1, 'day +' + k + ' tips ' + per.tips);
    Object.entries(per).forEach(([cat, n]) => assert.ok(n <= 3, 'day +' + k + ' ' + cat + '=' + n));
  }
});

test('no duplicate insight within a day', () => {
  for (let k = 0; k < 200; k++) {
    const ids = T.pickInsights(poolRich, day(k)).map(x => x._k);
    assert.equal(new Set(ids).size, ids.length, 'day +' + k);
  }
});

test('sparse and empty data degrade gracefully (fewer or none, never a crash)', () => {
  const e = T.insights(variants.empty.D, variants.empty.R, variants.empty.ss, variants.empty.rs);
  assert.ok(Array.isArray(e));
  const s = T.insights(variants.sparse.D, variants.sparse.R, variants.sparse.ss, variants.sparse.rs);
  assert.ok(Array.isArray(s) && s.length <= 8);
});

test('insights() returns render-ready objects for the Home card', () => {
  const out = T.insights(variants.rich30.D, variants.rich30.R, variants.rich30.ss, variants.rich30.rs);
  assert.ok(out.length >= 4 && out.length <= 8, 'real-date run returned ' + out.length);
  out.forEach(x => { assert.ok(x.t && x.i && x.act && 'v' in x && 'id' in x); });
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
