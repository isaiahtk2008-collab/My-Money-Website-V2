// Run with: node --test tests/row-id-site.test.mjs
// Loads the REAL row edit/delete code out of index.html (no copies) into a sandbox with stubs, and proves:
//  - when the loaded Expenses tab has a Row ID and this row has one, edit and delete requests carry `rowId` (plus row and expect)
//  - when the tab has NO Row ID column, the request body is exactly the old one (no rowId key at all)
//  - when the tab has the column but this row's ID is empty, nothing is sent and the buttons are replaced by the note
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.html'), 'utf8');
function constLine(name) { const m = html.match(new RegExp('^const ' + name + '=.*$', 'm')); if (!m) throw new Error(name + ' not found'); return m[0]; }
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
// async functions start with "async function", so take that prefix too
const asyncFn = name => 'async ' + fnBlock(name);

const HEAD_ID = ['Item Purchased', 'Amount', 'Date of Purchase', 'Row ID'];
const HEAD_NO = ['Item Purchased', 'Amount', 'Date of Purchase'];
const cells = (item, amount, date, rid) => { const o = { 'Item Purchased': item, Amount: amount, 'Date of Purchase': date }; if (rid !== undefined) o['Row ID'] = rid; return o; };
const tabWithIds = () => ({ sheet: 'Expenses', headers: HEAD_ID, rows: [cells('Coffee', 4.5, '2026-10-01', 'rabc1'), cells('Lunch', 12, '2026-10-02', null)] });
const tabNoCol = () => ({ sheet: 'Expenses', headers: HEAD_NO, rows: [cells('Coffee', 4.5, '2026-10-01'), cells('Lunch', 12, '2026-10-02')] });
const expense = (id, row, item, amount) => ({ id, row, item, amount, date: new Date(2026, 9, 1), place: 'Cafe', category: 'Food', payment: 'Debit', tag: 'Personal' });

function make(tab, formValues = {}) {
  const calls = [], errs = [];
  const store = { base: { Expenses: tab }, raw: null, D: { byId: new Map() } };
  store.D.byId.set('e1', { type: 'expense', o: expense('e1', 2, 'Coffee', 4.5) });
  store.D.byId.set('e2', { type: 'expense', o: expense('e2', 3, 'Lunch', 12) });
  store.D.byId.set('e99', { type: 'expense', o: expense('e99', 99, 'Ghost', 1) });   // a row that is not in the sheet at all
  const ctx = vm.createContext({
    console,
    store, calls, errs,
    esc: s => String(s),
    sheetCall: async p => { calls.push(JSON.parse(JSON.stringify(p))); return { ok: true }; },
    rowShowErr: e => { errs.push(e.message); },
    rowSetBusy: () => {}, patchExpenses: () => {}, closeOverlay: () => {}, toast: () => {}, syncSoon: () => {},
    $: sel => (typeof sel === 'string' && sel.startsWith('#ed-') && sel.slice(1) in formValues ? { value: formValues[sel.slice(1)] } : null),
    $$: () => [],
    num: v => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; },
    pd: v => new Date(v)
  });
  vm.runInContext([
    'let rowBusy=false;',
    constLine('isoDay'),
    fnBlock('rowExpect'), fnBlock('rowIdInfo'), constLine('rowFootHtml'), constLine('rowRef'),
    asyncFn('deleteRowGo'), asyncFn('saveRowEdit'),
    'globalThis.__t={rowIdInfo,rowFootHtml,rowRef,deleteRowGo,saveRowEdit};'
  ].join('\n'), ctx);
  return { T: ctx.__t, calls, errs, o: id => store.D.byId.get(id).o };
}

const EXPECT_COFFEE = { 'Item Purchased': 'Coffee', Amount: 4.5, 'Date of Purchase': '2026-10-01' };
const EXPECT_LUNCH = { 'Item Purchased': 'Lunch', Amount: 12, 'Date of Purchase': '2026-10-02' };

test('delete with a Row ID sends rowId in addition to row and expect', async () => {
  const { T, calls } = make(tabWithIds());
  await T.deleteRowGo('e1');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { action: 'delete', target: 'Expenses', row: 2, expect: EXPECT_COFFEE, rowId: 'rabc1' });
});

test('delete with NO Row ID column sends exactly the old body (no rowId key)', async () => {
  const { T, calls } = make(tabNoCol());
  await T.deleteRowGo('e1');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { action: 'delete', target: 'Expenses', row: 2, expect: EXPECT_COFFEE });
  assert.equal('rowId' in calls[0], false);
  assert.equal(JSON.stringify(calls[0]), JSON.stringify({ action: 'delete', target: 'Expenses', row: 2, expect: EXPECT_COFFEE }));
});

test('delete is refused (nothing sent) when the column exists but this row has no ID', async () => {
  const { T, calls, errs } = make(tabWithIds());
  await T.deleteRowGo('e2');
  assert.equal(calls.length, 0);
  assert.deepEqual(errs, ['noid']);
});

test('edit with a Row ID sends rowId in addition to row, expect and changes', async () => {
  const { T, calls } = make(tabWithIds(), { 'ed-amt': '99', 'ed-date': '2026-10-01', 'ed-where': 'Cafe', 'ed-pay': 'Debit', 'ed-cat': 'Food', 'ed-type': 'Personal' });
  await T.saveRowEdit('e1');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { action: 'edit', target: 'Expenses', row: 2, expect: EXPECT_COFFEE, changes: { Amount: 99 }, rowId: 'rabc1' });
});

test('edit with NO Row ID column sends exactly the old body (no rowId key)', async () => {
  const { T, calls } = make(tabNoCol(), { 'ed-amt': '99', 'ed-date': '2026-10-01', 'ed-where': 'Cafe', 'ed-pay': 'Debit', 'ed-cat': 'Food', 'ed-type': 'Personal' });
  await T.saveRowEdit('e1');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { action: 'edit', target: 'Expenses', row: 2, expect: EXPECT_COFFEE, changes: { Amount: 99 } });
  assert.equal('rowId' in calls[0], false);
});

test('edit is refused (nothing sent) when the column exists but this row has no ID', async () => {
  const { T, calls, errs } = make(tabWithIds(), { 'ed-amt': '99', 'ed-date': '2026-10-02', 'ed-where': 'Cafe', 'ed-pay': 'Debit', 'ed-cat': 'Food', 'ed-type': 'Personal' });
  await T.saveRowEdit('e2');
  assert.equal(calls.length, 0);
  assert.deepEqual(errs, ['noid']);
});

test('footer: buttons when there is an ID or no Row ID column; only the note when the ID is empty', () => {
  const a = make(tabWithIds());
  assert.match(a.T.rowFootHtml(a.o('e1')), /data-act="rowdel"[\s\S]*data-act="rowedit"/);
  const blocked = a.T.rowFootHtml(a.o('e2'));
  assert.ok(!blocked.includes('data-act="rowdel"') && !blocked.includes('data-act="rowedit"'));
  assert.ok(blocked.includes('Run the ID backfill first'));
  const b = make(tabNoCol());
  const old = b.T.rowFootHtml(b.o('e2'));
  assert.ok(old.includes('data-act="rowdel"') && old.includes('data-act="rowedit"') && !old.includes('backfill'));
});

test('a row is never shown by its number alone when it has an ID', () => {
  const a = make(tabWithIds());
  assert.equal(a.T.rowRef(a.o('e1')), 'ID rabc1 (row 2)');
  const b = make(tabNoCol());
  assert.equal(b.T.rowRef(b.o('e1')), 'row 2');
});

test('Row ID header is matched loosely, like the script does', () => {
  for (const h of ['Row ID', 'row id', 'RowID', ' ROW_ID ']) {
    const tab = { sheet: 'Expenses', headers: ['Item Purchased', 'Amount', 'Date of Purchase', h], rows: [{ ...cells('Coffee', 4.5, '2026-10-01'), [h]: 'rx1' }] };
    const m = make(tab);
    assert.deepEqual({ ...m.T.rowIdInfo(m.o('e1')) }, { hasCol: true, id: 'rx1', blocked: false }, h);
  }
});

test('a row that is not in the sheet yet keeps the old behaviour even with a Row ID column', async () => {
  const { T, calls, errs, o } = make(tabWithIds());
  assert.equal(T.rowIdInfo(o('e99')).blocked, false);
  await T.deleteRowGo('e99');
  assert.equal(calls.length, 0);
  assert.deepEqual(errs, ['norow']);
});
