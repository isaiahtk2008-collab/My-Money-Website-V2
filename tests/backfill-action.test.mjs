// Run with: node --test tests/backfill-action.test.mjs
// Loads apps-script.gs with a mocked Google Sheet and checks the doPost action `backfill` (what the site's "Fill missing IDs" button sends):
// it fills ONLY empty "Row ID" cells on rows with real data, exactly like the hand-run backfillRowIds(), and nothing else ever changes.
import test from 'node:test';
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
function load(sheets, { lockFails = false, secret = null } = {}) {
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
  vm.runInContext(secret == null ? code : code.replace(/const SECRET = '[^']*';/, `const SECRET = '${secret}';`), ctx);
  return ctx;
}
const plain = x => JSON.parse(JSON.stringify(x)); // objects built in the vm context are not reference-equal to host objects
const expensesGrid = () => [
  ['Timestamp', 'Item Purchased', 'Amount', 'Row ID'],
  ['2026-01-01', 'Coffee', 4.5, 'rOLD1'],
  ['2026-01-02', 'Snack', 3, ''],
  ['', 'Lunch', '', ''],
  ['', '', '', ''],
  ['2026-01-03', 'Cable', 9, 0]
];
const soldGrid = () => [['Timestamp', 'Model', 'Price'], ['2026-01-01', 'Phone', 500], ['2026-01-02', 'Case', 20]];
const post = (ctx, body) => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(body) } }).text);
function setup() {
  const exp = makeSheet('Expenses', expensesGrid());
  const sold = makeSheet('Form Responses - Sold', soldGrid());
  const sum = makeSheet('Summary', [['Total', 'Row ID'], ['x', '']]);
  return { exp, sold, sum, sheets: [exp, sold, sum] };
}

test('backfill fills only the empty Row ID cells on rows with data', () => {
  const { exp, sheets } = setup(); const ctx = load(sheets);
  const res = post(ctx, { action: 'backfill' });
  assert.equal(res.ok, true);
  assert.equal(res.total, 2);
  assert.deepEqual(plain(res.counts), { Expenses: 2 });
  assert.deepEqual(exp.writes.map(w => [w[0], w[1]]), [[3, 4], [4, 4]]);
  assert.match(String(exp.grid[2][3]), /^r[0-9a-z]+$/);
  assert.match(String(exp.grid[3][3]), /^r[0-9a-z]+$/);
  assert.notEqual(exp.grid[2][3], exp.grid[3][3]);
  assert.equal(exp.grid[1][3], 'rOLD1');
  assert.equal(exp.grid[5][3], 0);
  assert.equal(exp.grid[4][3], '');
});

test('nothing else is touched: other tabs untouched, only D3 and D4 differ on Expenses', () => {
  const { exp, sold, sum, sheets } = setup(); const ctx = load(sheets);
  post(ctx, { action: 'backfill' });
  assert.equal(sold.writes.length, 0);
  assert.equal(sum.writes.length, 0);
  assert.deepEqual(sold.grid, soldGrid());
  assert.deepEqual(sum.grid, [['Total', 'Row ID'], ['x', '']]);
  const orig = expensesGrid();
  assert.equal(exp.grid.length, orig.length);
  exp.grid.forEach((row, r) => row.forEach((v, c) => {
    if ((r === 2 || r === 3) && c === 3) assert.notEqual(v, orig[r][c]);
    else assert.equal(v, orig[r][c]);
  }));
});

test('running it twice changes nothing the second time', () => {
  const { exp, sheets } = setup(); const ctx = load(sheets);
  assert.equal(post(ctx, { action: 'backfill' }).total, 2);
  assert.equal(exp.writes.length, 2);
  const again = post(ctx, { action: 'backfill' });
  assert.equal(again.ok, true);
  assert.equal(again.total, 0);
  assert.equal(exp.writes.length, 2);
});

test('same result as the hand-run backfillRowIds()', () => {
  const a = setup(), b = setup();
  assert.equal(post(load(a.sheets), { action: 'backfill' }).total, load(b.sheets).backfillRowIds().total);
});

test('a backfill request never goes down the add path', () => {
  const { exp, sheets } = setup(); const ctx = load(sheets);
  const res = post(ctx, { action: 'backfill', id: 'x1', tab: 'Expenses', values: { 'Item Purchased': 'SNEAK' } });
  assert.equal(res.ok, true);
  assert.equal('dup' in res, false);
  assert.equal(exp.grid.length, expensesGrid().length);
  assert.equal(exp.grid.flat().includes('SNEAK'), false);
});

test('the secret is still required', () => {
  const { exp, sheets } = setup(); const ctx = load(sheets, { secret: 'abc' });
  const bad = post(ctx, { action: 'backfill' });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'auth');
  assert.equal(exp.writes.length, 0);
  const good = post(ctx, { action: 'backfill', secret: 'abc' });
  assert.equal(good.ok, true);
  assert.equal(good.total, 2);
});

test('if the lock cannot be taken, nothing is written', () => {
  const { exp, sold, sum, sheets } = setup(); const ctx = load(sheets, { lockFails: true });
  const res = post(ctx, { action: 'backfill' });
  assert.notEqual(res.ok, true);
  assert.equal(exp.writes.length + sold.writes.length + sum.writes.length, 0);
});

test('the GET reply tells the site this script supports backfill', () => {
  const { sheets } = setup(); const ctx = load(sheets);
  const res = JSON.parse(ctx.doGet({ parameter: {} }).text);
  assert.equal(res.ok, true);
  assert.equal(res.backfill, true);
  assert.equal(res.edit, true);
  assert.equal(res.read, true);
});
