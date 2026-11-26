// Run with: node --test tests/other-income.test.mjs
// Loan result and kept (forfeited) deposits show up as "other income": counted separately from reselling profit,
// in their own colours, with reselling profit itself left untouched.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.html'), 'utf8');
const a = html.indexOf('const OWED_LOAN_STATUSES');
const b = html.indexOf('/* ===== TRADING + PRE-IPO MODELS');
const c = html.indexOf('/* Chips and the "Profit by source" strip');
const d = html.indexOf("function card(title,body,right='',cls=''){", c);
assert.ok(a > 0 && b > a && c > 0 && d > c);
const D = (y, m, dd) => new Date(y, m - 1, dd);
const pad = n => String(n).padStart(2, '0');
const ctx = {
  Date, Math, JSON, Object, Array, String, Set, Boolean,
  TODAY: D(2026, 11, 26),
  num: v => { const n = parseFloat(String(v).replace(/[$,]/g, '')); return isNaN(n) ? null : n; },
  pd: v => { if (v instanceof Date) return v; const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || '')); return m ? D(+m[1], +m[2], +m[3]) : null; },
  diffD: (x, y) => Math.round((y - x) / 864e5),
  isoDay: x => x.getFullYear() + '-' + pad(x.getMonth() + 1) + '-' + pad(x.getDate()),
  mny: n => '$' + n, M: n => '$' + n, fdy: x => x.toISOString().slice(0, 10), esc: s => String(s == null ? '' : s),
  store: { D: { items: [] } }, LS: { get: () => null }
};
vm.createContext(ctx);
vm.runInContext(html.slice(a, b) + '\n' + html.slice(c, d) + '\nthis.api={owedModel,owedIncomeStats,owedIncomeSeries,profitSourcesCard,incChip};', ctx);
const { owedModel, owedIncomeStats, owedIncomeSeries, profitSourcesCard, incChip } = ctx.api;

const row = o => Object.assign({ 'Row ID': 'R' + Math.random().toString(36).slice(2, 7), Type: 'Loan', Person: 'Ali', 'Item / Device': 'x', 'Total Amount': 100, 'Amount Paid': 0, 'Date Out': '2026-11-01' }, o);
const model = rows => owedModel({ Owed: { rows: rows.map((r, i) => Object.assign({ _row: i + 2 }, r)) } }, ctx.TODAY);
const base = () => model([
  row({ 'Amount Paid': 120, Status: 'Returned', 'Date Closed': '2026-11-20' }),                 // loan +20
  row({ 'Amount Paid': 70, Status: 'Returned', 'Date Closed': '2026-10-05' }),                  // loan -30 (older)
  row({ Type: 'Deposit', Person: 'Bo', 'Total Amount': 500, 'Amount Paid': 100, Status: 'Forfeited', 'Date Closed': '2026-11-22' }), // kept 100
  row({ Type: 'Deposit', Person: 'Cy', 'Total Amount': 500, 'Amount Paid': 100, Status: 'Picked Up', 'Date Closed': '2026-11-22' }), // not income
  row({ Type: 'Deposit', Person: 'Di', 'Total Amount': 500, 'Amount Paid': 50, Status: 'Refunded', 'Date Closed': '2026-11-22' }),   // not income
  row({ Type: 'Deposit', Person: 'Ed', 'Total Amount': 500, 'Amount Paid': 80, Status: 'Waiting' }),                               // still open
  row({ 'Amount Paid': 0, Status: 'Out' })                                                                                           // open loan
]);

test('only forfeited deposits count, and only for the amount paid', () => {
  const m = base();
  assert.equal(m.totals.depForfeited, 100);
  assert.equal(m.totals.depForfeitedN, 1);
  assert.equal(m.deps.find(x => x.name === 'Cy').forfeit, null);
  assert.equal(m.deps.find(x => x.name === 'Di').forfeit, null);
  assert.equal(m.deps.find(x => x.name === 'Ed').forfeit, null);
});

test('all-time other income = loan net + kept deposits, kept apart', () => {
  const s = owedIncomeStats(base());
  assert.deepEqual({ loan: s.loan, loanN: s.loanN, dep: s.dep, depN: s.depN, total: s.total }, { loan: -10, loanN: 2, dep: 100, depN: 1, total: 90 });
});

test('a date range only counts what closed inside it', () => {
  const s = owedIncomeStats(base(), { start: D(2026, 11, 1), end: D(2026, 11, 30) });
  assert.equal(s.loan, 20); assert.equal(s.dep, 100); assert.equal(s.total, 120);
  const none = owedIncomeStats(base(), { start: D(2026, 1, 1), end: D(2026, 1, 31) });
  assert.equal(none.total, 0); assert.equal(none.loanN + none.depN, 0);
});

test('no Owed tab, or nothing closed: zero and no strip', () => {
  assert.equal(owedIncomeStats(owedModel({}, ctx.TODAY)).total, 0);
  assert.equal(owedIncomeStats(null).total, 0);
  assert.equal(profitSourcesCard(500, owedIncomeStats(model([row({})]))), '');
});

test('per-bucket series lines up with the chart buckets', () => {
  const ser = owedIncomeSeries(base(), [{ s: D(2026, 10, 1), e: D(2026, 10, 31) }, { s: D(2026, 11, 1), e: D(2026, 11, 30) }]);
  assert.deepEqual(ser, [-30, 120]);
});

test('the strip uses separate colours per source and leaves reselling profit alone', () => {
  const oi = owedIncomeStats(base(), { start: D(2026, 11, 1), end: D(2026, 11, 30) });
  const h = profitSourcesCard(500, oi);
  assert.match(h, /inc-chip resell/); assert.match(h, /inc-chip loan/); assert.match(h, /inc-chip dep/);
  assert.match(h, /var\(--inc-loan\)/); assert.match(h, /var\(--inc-dep\)/); assert.match(h, /var\(--inc-resell\)/);
  assert.match(h, /\$620/);            // 500 + 20 + 100
  assert.match(h, /Reselling \+\$500/);
  assert.match(incChip('loan', 'Loans', -10), /Loans -\$10/);
});

test('colour tokens exist for light and dark, with paychecks reserved', () => {
  for (const t of ['--inc-loan', '--inc-dep', '--inc-pay', '--inc-resell']) assert.ok(html.split(t + ':').length >= 3, t);
  assert.match(html, /\.inc-chip\.pay\{/);
});

test('Home, hero net, Reselling and Owed are wired to it', () => {
  assert.match(html, /\$\{profitSourcesCard\(rs\.profit,oi\)\}/);
  assert.match(html, /k==='All'\?profitSourcesCard\(rs\.profit,oiR\)/);
  assert.match(html, /var netTotal = profitTotal \+ extraTotal - spendTotal/);
  assert.match(html, /Kept from deposits/);
  // reselling profit tile itself is still pure
  assert.match(html, /kpi\(\{label:'Reselling profit',val:SM\(rs\.profit\)/);
});
