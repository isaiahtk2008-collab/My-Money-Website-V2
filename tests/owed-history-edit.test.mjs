// Run with: node --test tests/owed-history-edit.test.mjs
// Loads the REAL Owed code out of index.html and proves:
//  - owedEditChanges sends only fields that changed, never Type or Row ID, and locks the row with an expect block
//  - closing sets Date Closed once, reopening clears it, bad input is refused, "no changes" is refused
//  - owedRows lists EVERY closed entry (no 10-row cap), each expandable, and Mark sold appears only for a matched open deposit
//  - the new code only uses the existing locked edit action (no delete, no new tab, no new endpoint)
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.html'), 'utf8');
const a = html.indexOf('const OWED_LOAN_STATUSES');
const b = html.indexOf('/* ===== TRADING + PRE-IPO MODELS');
assert.ok(a > 0 && b > a, 'owed block found');
const block = html.slice(a, b);

const D = (y, m, d) => new Date(y, m - 1, d);
const pad = n => String(n).padStart(2, '0');
const ctx = {
  Date, Math, JSON, Object, Array, String, Set, Boolean,
  TODAY: D(2026, 11, 16),
  num: v => { const n = parseFloat(String(v).replace(/[$,]/g, '')); return isNaN(n) ? null : n; },
  pd: v => { if (v instanceof Date) return v; const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || '')); return m ? D(+m[1], +m[2], +m[3]) : null; },
  diffD: (a, b) => Math.round((b - a) / 864e5),
  isoDay: d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()),
  mny: n => '$' + n, M: n => '$' + n, fdy: d => d.toISOString().slice(0, 10), esc: s => String(s == null ? '' : s),
  store: { D: { items: [] } }, LS: { get: () => null }
};
vm.createContext(ctx);
vm.runInContext(block + '\nthis.api={owedModel,owedEditChanges,owedRows,owedBackupHtml,owedDeviceFor};', ctx);
const { owedModel, owedEditChanges, owedRows, owedBackupHtml } = ctx.api;

const row = o => Object.assign({ 'Row ID': 'R1', Type: 'Loan', Person: 'Ali', 'Item / Device': 'Cash', 'Total Amount': 100, 'Amount Paid': 0, 'Date Out': '2026-11-01', 'Due Date': '2026-12-01', Status: 'Out', 'Phone / Email': '', Notes: '' }, o);
const model = rows => owedModel({ Owed: { rows: rows.map((r, i) => Object.assign({ _row: i + 2 }, r)) } }, ctx.TODAY);
const full = (it, over = {}) => Object.assign({ person: it.name, item: it.item || it.device, total: it.loaned ?? it.total, paid: it.repaid ?? it.paid, dateOut: '2026-11-01', due: '2026-12-01', contact: '', status: it.status || 'Out', notes: '' }, over);

test('no edits means nothing to save', () => {
  const it = model([row()]).loans[0];
  assert.equal(owedEditChanges(it, 'loan', full(it), ctx.TODAY).error, 'No changes to save');
});

test('only changed fields are sent; Type and Row ID never are; row is locked with expect', () => {
  const it = model([row()]).loans[0];
  const r = owedEditChanges(it, 'loan', full(it, { person: 'Ali B', total: '150', notes: 'texted' }), ctx.TODAY);
  assert.deepEqual(Object.keys(r.changes).sort(), ['Notes', 'Person', 'Total Amount']);
  assert.equal(r.changes['Total Amount'], 150);
  assert.equal(r.expect['Row ID'], 'R1');
  assert.equal(r.expect.Type, 'Loan');
  assert.equal(r.expect.Person, 'Ali');
  assert.ok(!('Type' in r.changes) && !('Row ID' in r.changes) && !('Timestamp' in r.changes));
});

test('closing sets Date Closed to today; reopening clears it', () => {
  const open = model([row()]).loans[0];
  const c = owedEditChanges(open, 'loan', full(open, { status: 'Returned' }), ctx.TODAY);
  assert.equal(c.changes.Status, 'Returned');
  assert.deepEqual(JSON.parse(JSON.stringify(c.changes['Date Closed'])), { $date: '2026-11-16' });
  const closed = model([row({ Status: 'Returned', 'Date Closed': '2026-11-10' })]).loans[0];
  const o = owedEditChanges(closed, 'loan', full(closed, { status: 'Out' }), ctx.TODAY);
  assert.equal(o.changes['Date Closed'], null);
  const keep = owedEditChanges(closed, 'loan', full(closed, { status: 'Written off' }), ctx.TODAY);
  assert.ok(!('Date Closed' in keep.changes), 'closed to another closed status keeps its close date');
});

test('a closed entry can be corrected without reopening it', () => {
  const closed = model([row({ Status: 'Returned', 'Date Closed': '2026-11-10' })]).loans[0];
  const r = owedEditChanges(closed, 'loan', full(closed, { paid: '100' }), ctx.TODAY);
  assert.deepEqual(Object.keys(r.changes), ['Amount Paid']);
});

test('bad input is refused and nothing is built', () => {
  const it = model([row()]).loans[0];
  for (const [over, msg] of [[{ person: ' ' }, /name/], [{ total: 'abc' }, /total/], [{ total: '-5' }, /total/], [{ paid: '-1' }, /paid/], [{ due: '2026-13-45' }, /date/], [{ due: 'tomorrow' }, /date/]]) {
    const r = owedEditChanges(it, 'loan', full(it, over), ctx.TODAY);
    assert.match(r.error, msg);
    assert.ok(!r.changes);
  }
  assert.ok(owedEditChanges(it, 'loan', null, ctx.TODAY).error);
});

test('deposit edit uses Deposit type and pickup date; blanking a date clears the cell', () => {
  const d = model([row({ Type: 'Deposit', 'Total Amount': 600, 'Amount Paid': 100, Status: 'Waiting', 'Item / Device': 'MacBook' })]).deps[0];
  const r = owedEditChanges(d, 'dep', full(d, { due: '' }), ctx.TODAY);
  assert.equal(r.expect.Type, 'Deposit');
  assert.equal(r.changes['Due Date'], null);
});

test('text that looks like a formula is passed through as text for the script to neutralize (never executed here)', () => {
  const it = model([row()]).loans[0];
  const r = owedEditChanges(it, 'loan', full(it, { notes: '=HYPERLINK("x")' }), ctx.TODAY);
  assert.equal(r.changes.Notes, '=HYPERLINK("x")');
});

test('every closed entry is listed (no cap), each expandable with all fields, newest close first', () => {
  const rows = [row({ 'Row ID': 'OPEN', Status: 'Out' })];
  for (let i = 0; i < 15; i++) rows.push(row({ 'Row ID': 'C' + i, Person: 'P' + i, Status: 'Returned', 'Date Closed': `2026-10-${pad(i + 1)}`, Notes: 'note' + i }));
  const m = model(rows);
  const out = owedRows(m.loans, 'loan');
  assert.match(out, /Closed \(15\)/);
  assert.equal((out.match(/<details/g) || []).length, 16, 'outer + 15 inner');
  assert.ok(out.indexOf('P14') < out.indexOf('P0'), 'newest closed first');
  assert.match(out, /Date closed/);
  assert.match(out, /note14/);
  assert.match(out, /data-owed-full="loan" data-oid="C3"/);
  assert.match(out, /data-owed-full="loan" data-oid="OPEN"/, 'open rows can be edited too');
});

test('Mark sold shows only for an open deposit that matches an unsold device', () => {
  const m = model([row({ 'Row ID': 'D1', Type: 'Deposit', Person: 'Mike', 'Item / Device': 'MacBook Air M1', 'Total Amount': 600, 'Amount Paid': 100, Status: 'Waiting' })]);
  assert.ok(!/data-owed-sell/.test(owedRows(m.deps, 'dep')), 'no device matched');
  ctx.store.D.items = [{ kind: 'PC', sold: false, name: 'MacBook Air M1', label: 'MacBook Air M1', pendingDep: { id: 'D1' } }];
  assert.match(owedRows(m.deps, 'dep'), /data-owed-sell="D1"/);
  ctx.store.D.items = [{ kind: 'PC', sold: true, name: 'MacBook Air M1', pendingDep: { id: 'D1' } }];
  assert.ok(!/data-owed-sell/.test(owedRows(m.deps, 'dep')), 'sold device: no button');
  ctx.store.D.items = [];
});

test('backup status: saved / waiting / missing ID / not connected', () => {
  const m = model([row(), row({ 'Row ID': '', Person: 'Bo' })]);
  ctx.LS.get = k => (k === 'lgUrl' ? 'https://x' : null);
  assert.match(owedBackupHtml(m), /no Row ID/);
  assert.match(owedBackupHtml(model([row()])), /All 1 loan and deposit/);
  ctx.LS.get = k => (k === 'lgUrl' ? 'https://x' : k === 'lg.q' ? JSON.stringify([{ tab: 'Owed' }, { tab: 'Expenses' }]) : null);
  assert.match(owedBackupHtml(model([row()])), /1 loan or deposit is waiting/);
  ctx.LS.get = () => null;
  assert.match(owedBackupHtml(model([row()])), /Not connected/);
});

test('new code only uses the existing locked edit action: no delete, no new tab, no other action', () => {
  const s = html.indexOf('function owedOpenFull'), e = html.indexOf('/* ===== OWED END');
  const code = block + html.slice(s, e);
  assert.ok(!/action:\s*'(delete|add|append|insert)/.test(code));
  assert.ok(!/deleteRow|insertSheet/.test(code));
  const actions = [...code.matchAll(/action:\s*'(\w+)'/g)].map(m => m[1]);
  assert.deepEqual([...new Set(actions)], ['edit']);
  assert.ok(!/target:\s*'(?!Owed')/.test(code), 'only the Owed tab is targeted');
});
