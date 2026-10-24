// Run with: node tests/row-id.test.mjs
// Loads apps-script.gs with a mocked Google Sheet and checks the optional "Row ID" column:
// only tabs that already have that header get an ID, everything else behaves exactly as before.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const code = fs.readFileSync(path.join(here, '..', 'apps-script.gs'), 'utf8');

function makeSheet(name, grid, formulas = {}, maxRows = grid.length) {
  const writes = [];
  const sheet = {
    name, grid, formulas, writes, maxRows,
    getName: () => name,
    getLastRow: () => grid.length,
    getLastColumn: () => Math.max(0, ...grid.map(r => r.length)),
    getMaxRows: () => sheet.maxRows,
    insertRowsAfter: (after, n) => { for (let i = 0; i < n; i++) grid.push([]); sheet.maxRows += n; },
    getRange(r, c, nr = 1, nc = 1) {
      return {
        getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => { const v = (grid[r - 1 + i] || [])[c - 1 + j]; return v === undefined ? '' : v; })),
        getFormula: () => formulas[r + ',' + c] || '',
        getValue: () => { const v = (grid[r - 1] || [])[c - 1]; return v === undefined ? '' : v; },
        setValue: v => { writes.push([r, c, v]); while (grid.length < r) grid.push([]); grid[r - 1][c - 1] = v; }
      };
    }
  };
  return sheet;
}

function load(sheets) {
  const props = {}, cache = {};
  const ctx = {
    console,
    ContentService: { MimeType: { JSON: 'JSON' }, createTextOutput: s => ({ text: s, setMimeType(m) { this.mime = m; return this; } }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheets: () => sheets, getSpreadsheetTimeZone: () => 'UTC' }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    CacheService: { getScriptCache: () => ({ get: k => cache[k] || null, put: (k, v) => { cache[k] = v; } }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] || null, setProperty: (k, v) => { props[k] = v; } }) },
    Utilities: { formatDate: (d, tz, f) => (f === 'yyyy-MM-dd' ? d.toISOString().slice(0, 10) : d.toISOString().slice(11, 19)) }
  };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return ctx;
}

const parse = out => { assert.equal(out.mime, 'JSON'); return JSON.parse(out.text); };
const post = (ctx, body) => parse(ctx.doPost({ postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) } }));

// A tab that already has a "Row ID" header (one old row that already has its ID)
function withRowId() {
  const expenses = makeSheet('Expenses', [
    ['Timestamp', 'Item Purchased', 'Amount', 'Row ID'],
    ['', 'Coffee', 4.5, 'rOLD1']
  ], {}, 10);
  return { expenses, sheets: [expenses] };
}

// The same tab without a "Row ID" header: must behave exactly as it did before this change
function withoutRowId() {
  const expenses = makeSheet('Expenses', [
    ['Timestamp', 'Item Purchased', 'Amount'],
    ['', 'Coffee', 4.5]
  ], {}, 10);
  return { expenses, sheets: [expenses] };
}

const entry = (id, item = 'Snack') => ({ id, tab: 'Expenses', values: { 'Item Purchased': item, Amount: 3 } });

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ok -', name); };

test('tab WITH a Row ID header gets a new ID on a new row (same write, reply carries it)', () => {
  const { expenses, sheets } = withRowId(); const ctx = load(sheets);
  const j = post(ctx, entry('x1'));
  assert.equal(j.ok, true); assert.equal(j.status, 'success'); assert.equal(j.row, 3);
  assert.equal(typeof j.rowId, 'string'); assert.match(j.rowId, /^r[0-9a-z]+$/);
  assert.deepEqual(j.unmatched, []);                                     // existing reply fields still there
  assert.equal(expenses.grid[2][3], j.rowId);                            // the ID is in the Row ID column of the new row
  assert.equal(expenses.grid[2][1], 'Snack'); assert.equal(expenses.grid[2][2], 3);
  assert.equal(expenses.grid[1][3], 'rOLD1');                            // the old row's ID is untouched
  assert.ok(expenses.writes.every(w => w[0] === 3));                     // only the new row was written
  assert.deepEqual(expenses.writes.map(w => w[1]).sort(), [1, 2, 3, 4]); // Timestamp, Item, Amount, Row ID
});

test('tab WITHOUT a Row ID header behaves exactly as before', () => {
  const { expenses, sheets } = withoutRowId(); const ctx = load(sheets);
  const j = post(ctx, entry('x2'));
  assert.equal(j.ok, true); assert.equal(j.row, 3);
  assert.equal('rowId' in j, false);
  assert.deepEqual(Object.keys(j), ['ok', 'row', 'unmatched', 'status']);  // reply shape unchanged
  assert.deepEqual(expenses.writes.map(w => w[1]), [1, 2, 3]);             // only Timestamp, Item, Amount written
  assert.equal(expenses.grid[2].length, 3);                                // no extra column filled
});

test('two new rows get different IDs', () => {
  const { expenses, sheets } = withRowId(); const ctx = load(sheets);
  const a = post(ctx, entry('y1', 'A')); const b = post(ctx, entry('y2', 'B'));
  assert.equal(a.row, 3); assert.equal(b.row, 4);
  assert.equal(typeof a.rowId, 'string'); assert.equal(typeof b.rowId, 'string');
  assert.notEqual(a.rowId, b.rowId);
  assert.equal(expenses.grid[2][3], a.rowId); assert.equal(expenses.grid[3][3], b.rowId);
});

test('retrying the same id does not add a row or create a second ID', () => {
  const { expenses, sheets } = withRowId(); const ctx = load(sheets);   // one ctx, so the retry cache is shared like the real script
  const first = post(ctx, entry('z1'));
  const n = expenses.writes.length;
  const again = post(ctx, entry('z1'));
  assert.equal(again.ok, true); assert.equal(again.dup, true);
  assert.equal('rowId' in again, false);
  assert.equal(expenses.writes.length, n);                                // nothing written on the retry
  assert.equal(expenses.grid.length, 3);                                  // still just one new row
  assert.equal(expenses.grid[2][3], first.rowId);                         // the first ID is unchanged
});

test('a Row ID the caller sets is respected, not replaced', () => {
  const { expenses, sheets } = withRowId(); const ctx = load(sheets);
  const j = post(ctx, { id: 'c1', tab: 'Expenses', values: { 'Item Purchased': 'Gum', Amount: 1, 'Row ID': 'MINE-1' } });
  assert.equal(j.ok, true); assert.equal(j.rowId, 'MINE-1');
  assert.equal(expenses.grid[2][3], 'MINE-1');
});

test('never overwrites an existing Row ID cell: the target-row-not-empty check counts it', () => {
  const { expenses, sheets } = withRowId();
  expenses.grid.push(['', '', '', 'rKEEP']);                              // row 3 looks empty in the usual columns but already has an ID
  const ctx = load(sheets);
  const before = JSON.stringify(expenses.grid);
  const j = post(ctx, entry('d1'));
  assert.equal(j.ok, false); assert.equal(j.error, 'target row not empty');
  assert.equal(expenses.writes.length, 0);
  assert.equal(JSON.stringify(expenses.grid), before);
  assert.equal(expenses.grid[2][3], 'rKEEP');
});

test('a formula sitting in the Row ID cell is also never overwritten', () => {
  const { expenses, sheets } = withRowId();
  expenses.grid.push(['', '', '', '']); expenses.formulas['3,4'] = '=ROW()';
  const ctx = load(sheets);
  const j = post(ctx, entry('e1'));
  assert.equal(j.ok, false); assert.equal(j.error, 'target row not empty');
  assert.equal(expenses.writes.length, 0);
  assert.equal(expenses.formulas['3,4'], '=ROW()');
});

console.log(`\n${passed} tests passed`);
