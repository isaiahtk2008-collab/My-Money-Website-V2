// Run with: node tests/row-id-backfill.test.mjs
// Loads apps-script.gs with a mocked Google Sheet and checks backfillRowIds() / fillMissingIdsOnSubmit():
// they fill ONLY empty "Row ID" cells on rows with real data, and nothing else in the sheet ever changes.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const code = fs.readFileSync(path.join(here, '..', 'apps-script.gs'), 'utf8');

function makeSheet(name, grid, formulas = {}) {
  const writes = [];
  const sheet = {
    name, grid, formulas, writes,
    getName: () => name,
    getLastRow: () => grid.length,
    getLastColumn: () => Math.max(0, ...grid.map(r => r.length)),
    getMaxRows: () => grid.length,
    insertRowsAfter: () => { throw new Error('rows must never be added'); },
    deleteRow: () => { throw new Error('rows must never be deleted'); },
    getRange(r, c, nr = 1, nc = 1) {
      const cell = (i, j) => { const v = (grid[r - 1 + i] || [])[c - 1 + j]; return v === undefined ? '' : v; };
      return {
        getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => cell(i, j))),
        getFormulas: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => formulas[(r + i) + ',' + (c + j)] || '')),
        getFormula: () => formulas[r + ',' + c] || '',
        getValue: () => cell(0, 0),
        setValue: v => { writes.push([r, c, v]); while (grid.length < r) grid.push([]); grid[r - 1][c - 1] = v; }
      };
    }
  };
  return sheet;
}

function load(sheets, { lockFails = false } = {}) {
  const ctx = {
    console: { log() {} },
    ContentService: { MimeType: { JSON: 'JSON' }, createTextOutput: s => ({ text: s, setMimeType() { return this; } }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheets: () => sheets, getSpreadsheetTimeZone: () => 'UTC' }) },
    LockService: { getScriptLock: () => ({ waitLock() { if (lockFails) throw new Error('busy'); }, releaseLock() {} }) },
    CacheService: { getScriptCache: () => ({ get: () => null, put() {} }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty() {} }) },
    Utilities: { formatDate: () => '' }
  };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return ctx;
}

const snap = sheets => JSON.stringify(sheets.map(s => s.grid));
const clone = grid => grid.map(r => r.slice());
const plain = x => JSON.parse(JSON.stringify(x)); // objects built inside the vm context are not reference-equal to host objects

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ok -', name); };

// Expenses has a Row ID header: row 2 has an ID, rows 3 and 4 are form rows without one, row 5 is blank, row 6 has data but a numeric 0 ID.
const expensesGrid = () => [
  ['Timestamp', 'Item Purchased', 'Amount', 'Row ID'],
  ['2026-01-01', 'Coffee', 4.5, 'rOLD1'],
  ['2026-01-02', 'Snack', 3, ''],
  ['', 'Lunch', '', ''],
  ['', '', '', ''],
  ['2026-01-03', 'Cable', 9, 0]
];
// Sold has no Row ID header at all.
const soldGrid = () => [
  ['Timestamp', 'Model', 'Price'],
  ['2026-01-01', 'Phone', 500],
  ['2026-01-02', 'Case', 20]
];

const setup = () => {
  const expenses = makeSheet('Expenses', expensesGrid());
  const sold = makeSheet('Form Responses - Sold', soldGrid());
  const ignored = makeSheet('Summary', [['Total', 'Row ID'], ['x', '']]); // not in ALLOWED_TABS
  return { expenses, sold, ignored, sheets: [expenses, sold, ignored] };
};

test('only empty Row ID cells on rows with real data are written', () => {
  const { expenses, sheets } = setup(); const ctx = load(sheets);
  const out = ctx.backfillRowIds();
  assert.equal(out.ok, true); assert.equal(out.total, 2);
  assert.deepEqual(expenses.writes.map(w => [w[0], w[1]]), [[3, 4], [4, 4]]);   // only Row ID column, only rows 3 and 4
  assert.match(expenses.grid[2][3], /^r[0-9a-z]+$/); assert.match(expenses.grid[3][3], /^r[0-9a-z]+$/);
  assert.notEqual(expenses.grid[2][3], expenses.grid[3][3]);                     // unique
  assert.deepEqual(expenses.grid[4], ['', '', '', '']);                          // blank row stays blank, no ID
});

test('existing IDs are unchanged (including a numeric 0)', () => {
  const { expenses, sheets } = setup(); const ctx = load(sheets);
  ctx.backfillRowIds();
  assert.equal(expenses.grid[1][3], 'rOLD1');
  assert.equal(expenses.grid[5][3], 0);
  assert.ok(!expenses.writes.some(w => w[0] === 2 || w[0] === 6));
});

test('tabs without a Row ID header, and tabs not in ALLOWED_TABS, are untouched', () => {
  const { sold, ignored, sheets } = setup(); const ctx = load(sheets);
  const out = ctx.backfillRowIds();
  assert.equal(sold.writes.length, 0); assert.equal(ignored.writes.length, 0);
  assert.deepEqual(sold.grid, soldGrid()); assert.deepEqual(ignored.grid, [['Total', 'Row ID'], ['x', '']]);
  assert.equal('Form Responses - Sold' in out.counts, false);
  assert.deepEqual(plain(out.counts), { Expenses: 2 });
});

test('running twice changes nothing the second time', () => {
  const { sheets } = setup(); const ctx = load(sheets);
  ctx.backfillRowIds();
  const after1 = snap(sheets);
  const out2 = ctx.backfillRowIds();
  assert.equal(out2.total, 0); assert.deepEqual(plain(out2.counts), { Expenses: 0 });
  assert.equal(snap(sheets), after1);
  const out3 = ctx.fillMissingIdsOnSubmit({});
  assert.equal(out3.total, 0); assert.equal(snap(sheets), after1);
});

test('no other cell changes: whole grid before vs after differs only in the filled Row ID cells', () => {
  const { expenses, sold, ignored, sheets } = setup(); const ctx = load(sheets);
  const before = sheets.map(s => clone(s.grid));
  ctx.backfillRowIds();
  sheets.forEach((s, i) => {
    assert.equal(s.grid.length, before[i].length);                               // no rows added or deleted
    s.grid.forEach((row, r) => row.forEach((val, c) => {
      const was = (before[i][r] || [])[c];
      if (val !== was) assert.ok(s === expenses && c === 3 && (r === 2 || r === 3), `unexpected change at ${s.name} r${r + 1} c${c + 1}`);
    }));
  });
  assert.deepEqual(sold.grid, before[1]); assert.deepEqual(ignored.grid, before[2]);
});

test('formula cells are never touched: a Row ID cell holding a formula is skipped, formula-only rows get no ID', () => {
  const grid = [
    ['Item Purchased', 'Amount', 'Row ID'],
    ['Tea', 2, ''],        // Row ID cell is a formula: must be skipped
    ['', 7, ''],           // Amount is a formula result, no real data: must get no ID
    ['Gum', 1, '']         // normal: gets an ID
  ];
  const expenses = makeSheet('Expenses', grid, { '2,3': '=ROW()', '3,2': '=1+6' });
  const ctx = load([expenses]);
  const out = ctx.backfillRowIds();
  assert.deepEqual(plain(out.counts), { Expenses: 1 });
  assert.deepEqual(expenses.writes.map(w => [w[0], w[1]]), [[4, 3]]);
});

test('generated IDs are unique even for a large batch', () => {
  const grid = [['Item Purchased', 'Row ID']];
  for (let i = 0; i < 3000; i++) grid.push(['item' + i, '']);
  const expenses = makeSheet('Expenses', grid);
  const ctx = load([expenses]);
  const out = ctx.backfillRowIds();
  assert.equal(out.total, 3000);
  assert.equal(new Set(expenses.grid.slice(1).map(r => r[1])).size, 3000);
});

test('if the lock cannot be taken, nothing is written', () => {
  const { sheets } = setup(); const ctx = load(sheets, { lockFails: true });
  const before = snap(sheets);
  const out = ctx.backfillRowIds();
  assert.equal(out.ok, false); assert.equal(snap(sheets), before);
  assert.equal(ctx.fillMissingIdsOnSubmit({}).ok, false); assert.equal(snap(sheets), before);
});

console.log(`\n${passed} checks passed`);
