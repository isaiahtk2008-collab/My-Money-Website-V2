// Run with: node --test tests/owed-loan-profit-loss.test.mjs
// Loads the REAL Owed code from index.html and proves:
//  - a closed loan that came back with MORE than was lent is profit; with LESS is a loss; equal is even
//  - open loans have no result and never count; deposits never count
//  - totals add up, and the new totals do not disturb the existing ones
//  - the close preview and the + menu "close" list behave, and closing reuses the existing locked edit (no new write path)
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.html'), 'utf8');
const a = html.indexOf('const OWED_LOAN_STATUSES');
const b = html.indexOf('/* ===== TRADING + PRE-IPO MODELS');
assert.ok(a > 0 && b > a);
const block = html.slice(a, b);
const D = (y, m, d) => new Date(y, m - 1, d);
const pad = n => String(n).padStart(2, '0');
const ctx = {
  Date, Math, JSON, Object, Array, String, Set, Boolean,
  TODAY: D(2026, 11, 26),
  num: v => { const n = parseFloat(String(v).replace(/[$,]/g, '')); return isNaN(n) ? null : n; },
  pd: v => { if (v instanceof Date) return v; const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || '')); return m ? D(+m[1], +m[2], +m[3]) : null; },
  diffD: (x, y) => Math.round((y - x) / 864e5),
  isoDay: d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()),
  mny: n => '$' + n, M: n => '$' + n, fdy: d => d.toISOString().slice(0, 10), esc: s => String(s == null ? '' : s),
  store: { D: { items: [] } }, LS: { get: () => null }
};
vm.createContext(ctx);
vm.runInContext(block + '\nthis.api={owedModel,owedResult,owedClosePreview,owedCloseList,owedLoanChanges,owedRows};', ctx);
const { owedModel, owedResult, owedClosePreview, owedCloseList, owedLoanChanges, owedRows } = ctx.api;

const row = o => Object.assign({ 'Row ID': 'R' + Math.random().toString(36).slice(2, 7), Type: 'Loan', Person: 'Ali', 'Item / Device': 'Cash', 'Total Amount': 10, 'Amount Paid': 0, 'Date Out': '2026-11-01', 'Due Date': '2026-12-01', Status: 'Out' }, o);
const model = rows => owedModel({ Owed: { rows: rows.map((r, i) => Object.assign({ _row: i + 2 }, r)) } }, ctx.TODAY);

test('lent 10, got 15 back: profit of 5', () => {
  const l = model([row({ 'Amount Paid': 15, Status: 'Returned', 'Date Closed': '2026-11-20' })]).loans[0];
  assert.equal(l.net, 5);
  assert.equal(owedResult(l.net).kind, 'profit');
});
test('lent 10, got 5 back and closed: loss of 5', () => {
  const l = model([row({ 'Amount Paid': 5, Status: 'Returned', 'Date Closed': '2026-11-20' })]).loans[0];
  assert.equal(l.net, -5);
  assert.equal(owedResult(l.net).kind, 'loss');
});
test('written off with nothing back is a loss of the full amount', () => {
  const l = model([row({ 'Amount Paid': 0, Status: 'Written off' })]).loans[0];
  assert.equal(l.net, -10);
});
test('paid back exactly is even; open loans have no result', () => {
  const m = model([row({ 'Amount Paid': 10, Status: 'Returned' }), row({ 'Amount Paid': 20 })]);
  const closed = m.loans.find(x => !x.open), open = m.loans.find(x => x.open);
  assert.equal(owedResult(closed.net).kind, 'even');
  assert.equal(open.net, null);
});
test('totals: profit, losses and net add up; open loans and deposits are ignored', () => {
  const m = model([
    row({ 'Amount Paid': 15, Status: 'Returned' }),          // +5
    row({ 'Total Amount': 100, 'Amount Paid': 130, Status: 'Returned' }), // +30
    row({ 'Amount Paid': 5, Status: 'Returned' }),           // -5
    row({ 'Total Amount': 50, 'Amount Paid': 0, Status: 'Written off' }), // -50
    row({ 'Total Amount': 999, 'Amount Paid': 0 }),          // open: ignored
    row({ Type: 'Deposit', 'Total Amount': 500, 'Amount Paid': 100, Status: 'Forfeited' }) // deposit: ignored
  ]);
  const t = m.totals;
  assert.equal(t.loanProfit, 35); assert.equal(t.loanLoss, 55); assert.equal(t.loanNet, -20);
  assert.equal(t.loansClosed, 4); assert.equal(t.loansProfitN, 2); assert.equal(t.loansLossN, 2);
  // existing totals unchanged in meaning
  assert.equal(t.owedToMe, 999); assert.equal(t.loansOpen, 1);
});
test('cents do not drift', () => {
  const m = model([row({ 'Total Amount': 10.1, 'Amount Paid': 10.3, Status: 'Returned' }), row({ 'Total Amount': 0.1, 'Amount Paid': 0.3, Status: 'Returned' })]);
  assert.equal(m.totals.loanProfit, 0.4);
});
test('no closed loans: totals are zero and nothing breaks', () => {
  const t = model([row()]).totals;
  assert.equal(t.loansClosed, 0); assert.equal(t.loanNet, 0);
  assert.doesNotThrow(() => model([]));
});
test('close preview: typed payment turns into profit or loss; Out gives no preview', () => {
  const it = model([row()]).loans[0];
  assert.equal(owedClosePreview(it, '15', 'Returned').text, 'This closes as: Profit $5');
  assert.equal(owedClosePreview(it, '5', 'Returned').text, 'This closes as: Loss $5');
  assert.equal(owedClosePreview(it, '', 'Written off').text, 'This closes as: Loss $10');
  assert.equal(owedClosePreview(it, '15', 'Out'), null);
  assert.equal(owedClosePreview(it, 'abc', 'Returned'), null);
});
test('closing reuses the existing safe edit: sets Status and Date Closed, locks the row with expect, nothing else', () => {
  const it = model([row({ 'Row ID': 'RX' })]).loans[0];
  const r = owedLoanChanges(it, { repay: '15', due: '', status: 'Returned' }, ctx.TODAY);
  assert.deepEqual(Object.keys(r.changes).sort(), ['Amount Paid', 'Date Closed', 'Status']);
  assert.equal(r.changes['Amount Paid'], 15);
  assert.equal(r.expect['Row ID'], 'RX');
});
test('close list: open entries with a Row ID only, earliest due first', () => {
  const m = model([
    row({ 'Row ID': 'L1', 'Due Date': '2026-12-20' }),
    row({ 'Row ID': 'L2', 'Due Date': '2026-12-02' }),
    row({ 'Row ID': '', Person: 'NoId' }),
    row({ 'Row ID': 'L3', Status: 'Returned' }),
    row({ 'Row ID': 'D1', Type: 'Deposit', Status: 'Waiting', 'Due Date': '2026-12-10' })
  ]);
  assert.deepEqual(Array.from(owedCloseList(m).map(x => x.id)), ['L2', 'D1', 'L1']);
  assert.equal(owedCloseList({ hasOwed: false }).length, 0);
});
test('closed list shows the result chip for loans', () => {
  const m = model([row({ 'Amount Paid': 15, Status: 'Returned', 'Date Closed': '2026-11-20' })]);
  const out = owedRows(m.loans, 'loan');
  assert.match(out, /Profit \$5/);
});
