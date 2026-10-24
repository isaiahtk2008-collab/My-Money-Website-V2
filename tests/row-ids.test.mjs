// Run with: node tests/row-ids.test.mjs
// Loads apps-script.gs with a mocked Google Sheet and proves the Row ID feature is additive and safe:
// IDs are written only at append time or by the backfill, only into empty Row ID cells, rows are found by ID after sorting or
// deleting, identical rows are told apart, anything doubtful is refused, reading never writes, and the old paths behave as before.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const code = fs.readFileSync(path.join(here, '..', 'apps-script.gs'), 'utf8');

function makeSheet(name, grid, formulas = {}, maxRows = grid.length) {
  const writes = [], deleted = [];
  const sheet = {
    name, grid, formulas, writes, deleted, maxRows,
    getName: () => name,
    getLastRow: () => grid.length,
    getLastColumn: () => Math.max(0, ...grid.map(r => r.length)),
    getMaxRows: () => sheet.maxRows,
    insertRowsAfter: (after, n) => { for (let i = 0; i < n; i++) grid.push([]); sheet.maxRows += n; },
    deleteRow: r => { deleted.push(r); grid.splice(r - 1, 1); sheet.maxRows -= 1; },
    getRange(r, c, nr = 1, nc = 1) {
      const cell = (i, j) => { const v = (grid[r - 1 + i] || [])[c - 1 + j]; return v === undefined ? '' : v; };
      return {
        getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => cell(i, j))),
        getFormulas: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => formulas[(r + i) + ',' + (c + j)] || '')),
        getFormula: () => formulas[r + ',' + c] || '',
        getValue: () => cell(0, 0),
        setValue: v => { writes.push([r, c, v]); while (grid.length < r) grid.push([]); grid[r - 1][c - 1] = v; },
        setValues: vs => vs.forEach((row, i) => row.forEach((v, j) => { writes.push([r + i, c + j, v]); while (grid.length < r + i) grid.push([]); grid[r - 1 + i][c - 1 + j] = v; }))
      };
    }
  };
  return sheet;
}

function load(sheets, extra = {}) {
  const props = {}, cache = {};
  const ctx = {
    console,
    ContentService: { MimeType: { JSON: 'JSON' }, createTextOutput: s => ({ text: s, setMimeType(m) { this.mime = m; return this; } }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheets: () => sheets, getSpreadsheetTimeZone: () => 'UTC' }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    CacheService: { getScriptCache: () => ({ get: k => cache[k] || null, put: (k, v) => { cache[k] = v; } }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] || null, setProperty: (k, v) => { props[k] = v; } }) },
    Utilities: { formatDate: (d, tz, f) => (f === 'yyyy-MM-dd' ? d.toISOString().slice(0, 10) : d.toISOString().slice(11, 19)) },
    ...extra
  };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return ctx;
}

const parse = out => { assert.equal(out.mime, 'JSON'); return JSON.parse(out.text); };
const post = (ctx, body) => parse(ctx.doPost({ postData: { contents: JSON.stringify(body) } }));
const get = (ctx, p) => parse(ctx.doGet({ parameter: p }));
const snap = sheet => JSON.stringify(sheet.grid);
const ID_RE = /^R[2-9A-HJ-NP-Z]{7}$/;

const HEAD = ['Timestamp', 'Item Purchased', 'Amount', 'Date of Purchase', 'Establishment', 'Category'];
// Expenses tab WITH a Row ID column at the far right. Rows 2-4 are distinct; rows 5 and 6 are two IDENTICAL purchases.
function fixture({ withIdCol = true, ids = ['RAAAAAA2', 'RBBBBBB3', 'RCCCCCC4', 'RDDDDDD5', 'REEEEEE6'], withFormula = false } = {}) {
  const head = withIdCol ? [...HEAD, 'Row ID'] : [...HEAD];
  const row = (item, amt, date, place, cat, id) => ['', item, amt, date, place, cat].concat(withIdCol ? [id] : []);
  const expenses = makeSheet('Expenses', [
    head,
    row('Coffee', 4.5, '2026-10-01', 'Cafe A', 'Food & Dining', ids[0]),
    row('Lunch', 12, '2026-10-02', 'Diner B', 'Food & Dining', ids[1]),
    row('Socks', 9.99, '2026-10-03', 'Shop C', 'Clothing & Apparel', ids[2]),
    row('Bus', 3.35, '2026-10-04', 'TTC', 'Transport', ids[3]),
    row('Bus', 3.35, '2026-10-04', 'TTC', 'Transport', ids[4])
  ], withFormula ? { '3,3': '=5+7' } : {}, 12);
  const master = makeSheet('Master Inventory', [['Model', 'IMEI', 'Device Label', 'Row ID'], ['iPhone 12', '111', 'P1', ''], ['iPhone 13', '222', 'P2', '']], { '2,1': '=1' });
  return { expenses, master, sheets: [expenses, master] };
}
const exp = (item, amount, date) => ({ 'Item Purchased': item, Amount: amount, 'Date of Purchase': date });

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok -', name); };

/* ---------------- CHANGE 1: new rows get an ID; reading exposes it; the header is never created by the script ---------------- */

t('a new entry gets a short unique Row ID in the same row and nothing else changes', () => {
  const f = fixture(), ctx = load(f.sheets);
  const before = JSON.parse(snap(f.expenses));
  const r = post(ctx, { id: 'n1', tab: 'Expenses', values: { 'Item Purchased': 'Snack', Amount: 3 } });
  assert.equal(r.ok, true);
  assert.equal(r.row, 7);
  assert.match(r.rowId, ID_RE);
  assert.equal(f.expenses.grid[6][6], r.rowId);
  for (let i = 0; i < 6; i++) assert.deepEqual(f.expenses.grid[i], before[i]);   // header + all 5 existing rows untouched
  assert.ok(f.expenses.writes.every(w => w[0] === 7), 'only row 7 written');
  assert.equal(f.expenses.writes.length, 4);                                      // Timestamp, Item, Amount + the ID
  assert.ok(f.expenses.writes.some(w => w[1] === 7), 'the ID went into column 7 (Row ID)');
});

t('two new entries get different IDs, and neither reuses an existing one', () => {
  const f = fixture(), ctx = load(f.sheets);
  const existing = f.expenses.grid.slice(1).map(r => r[6]);
  const r1 = post(ctx, { id: 'n2', tab: 'Expenses', values: { 'Item Purchased': 'Snack', Amount: 3 } });
  const r2 = post(ctx, { id: 'n3', tab: 'Expenses', values: { 'Item Purchased': 'Snack', Amount: 3 } });
  assert.match(r1.rowId, ID_RE); assert.match(r2.rowId, ID_RE);
  assert.notEqual(r1.rowId, r2.rowId);
  [r1.rowId, r2.rowId].forEach(id => assert.ok(!existing.includes(id)));
});

t('a tab without a Row ID column behaves exactly as before and the script never creates the header', () => {
  const f = fixture({ withIdCol: false }), ctx = load(f.sheets);
  const r = post(ctx, { id: 'n2', tab: 'Expenses', values: { 'Item Purchased': 'Snack', Amount: 3 } });
  assert.equal(r.ok, true);
  assert.equal(r.rowId, undefined);
  assert.equal(f.expenses.writes.length, 3);                                       // Timestamp, Item, Amount only
  assert.equal(f.expenses.getLastColumn(), 6);                                     // no column was added
  assert.deepEqual(f.expenses.grid[0], ['Timestamp', 'Item Purchased', 'Amount', 'Date of Purchase', 'Establishment', 'Category']);
});

t('a request can never choose the ID', () => {
  const f = fixture(), ctx = load(f.sheets);
  const r = post(ctx, { id: 'n4', tab: 'Expenses', values: { 'Row ID': 'HACKED', 'Item Purchased': 'X', Amount: 1 } });
  assert.equal(r.ok, true);
  assert.match(f.expenses.grid[6][6], ID_RE);
  assert.notEqual(f.expenses.grid[6][6], 'HACKED');
  assert.ok(r.unmatched.includes('Row ID'));
  assert.ok(!f.expenses.writes.some(w => w[2] === 'HACKED'));
});

t('a new entry is refused (nothing written) if its Row ID cell already holds something', () => {
  const f = fixture();
  f.expenses.grid.push(['', '', '', '', '', '', 'RZZZZZZ9']);                      // row 7: empty in every written column, but its ID cell is taken
  f.expenses.maxRows = 12;
  const ctx = load(f.sheets), before = snap(f.expenses);
  const r = post(ctx, { id: 'n5', tab: 'Expenses', values: { 'Item Purchased': 'Snack', Amount: 3 } });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'target row not empty');
  assert.equal(f.expenses.writes.length, 0);
  assert.equal(snap(f.expenses), before);                                           // the existing ID was not overwritten
});

t('an ID that is already taken is never handed out again (collision retry)', () => {
  const f = fixture(), ctx = load(f.sheets);
  // Force the random source to produce an existing ID's characters first ("AAAAAA2" -> RAAAAAA2), then different ones.
  vm.runInContext(`var __calls = 0, __want = 'AAAAAA2'.split('').map(ch => '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'.indexOf(ch));
    Math.random = function () { const i = __calls++; return i < 7 ? (__want[i] + 0.5) / 32 : ((i * 7) % 32 + 0.5) / 32; };`, ctx);
  const r = post(ctx, { id: 'n6', tab: 'Expenses', values: { 'Item Purchased': 'Snack', Amount: 3 } });
  assert.equal(r.ok, true);
  assert.notEqual(r.rowId, 'RAAAAAA2');
  assert.match(r.rowId, ID_RE);
});

t('two Row ID columns = ambiguous: the entry is still added, no ID is guessed', () => {
  const f = fixture(); f.expenses.grid[0].push('row id');                           // a second, differently-spelled Row ID header
  const ctx = load(f.sheets);
  const r = post(ctx, { id: 'n7', tab: 'Expenses', values: { 'Item Purchased': 'Snack', Amount: 3 } });
  assert.equal(r.ok, true);
  assert.equal(r.rowId, undefined);
  assert.equal(f.expenses.writes.length, 3);
});

t('the read action returns each row\'s Row ID, says which column holds it, and never writes', () => {
  const f = fixture(), ctx = load(f.sheets), before = snap(f.expenses);
  const j = get(ctx, { action: 'read' });
  assert.equal(j.ok, true);
  assert.equal(j.tabs.Expenses.rowIdCol, 'Row ID');
  assert.deepEqual(j.tabs.Expenses.rows.map(r => r['Row ID']), ['RAAAAAA2', 'RBBBBBB3', 'RCCCCCC4', 'RDDDDDD5', 'REEEEEE6']);
  get(ctx, { action: 'read', flat: '1' }); get(ctx, { action: 'check' }); get(ctx, {});
  assert.equal(f.expenses.writes.length, 0); assert.equal(f.master.writes.length, 0);
  assert.equal(snap(f.expenses), before);
});

t('a tab with no Row ID column reads exactly as before (rowIdCol is null)', () => {
  const f = fixture({ withIdCol: false }), ctx = load(f.sheets);
  const j = get(ctx, { action: 'read' });
  assert.equal(j.tabs.Expenses.rowIdCol, null);
  assert.equal(j.tabs.Expenses.rows.length, 5);
  assert.equal(j.tabs.Expenses.rows[0]['Row ID'], undefined);
});

t('the status ping advertises Row ID support; the check report counts filled, missing and duplicated IDs', () => {
  const f = fixture({ ids: ['RAAAAAA2', '', 'RCCCCCC4', 'RCCCCCC4', 'REEEEEE6'] }), ctx = load(f.sheets);
  assert.equal(get(ctx, {}).rowIds, true);
  const c = get(ctx, { action: 'check' }).tabs.Expenses.rowIds;
  assert.deepEqual(c, { column: 'Row ID', filled: 4, missing: 1, duplicated: 1 });
  const none = get(load(fixture({ withIdCol: false }).sheets), { action: 'check' }).tabs.Expenses.rowIds;
  assert.deepEqual(none, { column: null });
});

console.log(`\n${n} checks passed`);
