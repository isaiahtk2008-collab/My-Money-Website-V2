// Run with: node tests/row-edit-delete.test.mjs
// Loads apps-script.gs with a mocked Google Sheet and proves edit/delete touch ONLY the one selected row,
// refuse when the row moved, refuse protected tabs, and that an old-style request can never add a row.
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
const post = (ctx, body) => parse(ctx.doPost({ postData: { contents: JSON.stringify(body) } }));
const snap = sheet => JSON.stringify(sheet.grid);

// Plain Expenses tab (no formulas) plus a protected formula tab.
function fixture({ withFormula = false } = {}) {
  const expenses = makeSheet('Expenses', [
    ['Timestamp', 'Item Purchased', 'Amount', 'Date of Purchase', 'Establishment', 'Category'],
    ['', 'Coffee', 4.5, '2026-10-01', 'Cafe A', 'Food & Dining'],
    ['', 'Lunch', 12, '2026-10-02', 'Diner B', 'Food & Dining'],
    ['', 'Socks', 9.99, '2026-10-03', 'Shop C', 'Clothing & Apparel']
  ], withFormula ? { '3,3': '=5+7' } : {}, 10);
  const master = makeSheet('Master Inventory', [['Model', 'IMEI', 'Device Label'], ['iPhone 12', '111', 'P1'], ['iPhone 13', '222', 'P2']], { '2,1': '=1' });
  return { expenses, master, sheets: [expenses, master] };
}
const exp = (item, amount, date) => ({ 'Item Purchased': item, Amount: amount, 'Date of Purchase': date });

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok -', name); };

t('discovery reply says edit is supported', () => {
  const ctx = load(fixture().sheets);
  const r = parse(ctx.doGet({ parameter: {} }));
  assert.equal(r.edit, true);
});

t('edit changes only the named cells of the one selected row', () => {
  const f = fixture(), ctx = load(f.sheets);
  const before = JSON.parse(snap(f.expenses));
  const r = post(ctx, { action: 'edit', target: 'Expenses', row: 3, expect: exp('Lunch', 12, '2026-10-02'), changes: { Amount: 14.25, Establishment: 'Diner Z', 'Date of Purchase': { $date: '2026-10-05' } } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.updated.sort(), ['Amount', 'Date of Purchase', 'Establishment'].sort());
  assert.equal(f.expenses.writes.length, 3);
  assert.ok(f.expenses.writes.every(w => w[0] === 3), 'only row 3 written');
  // every other row is byte-for-byte unchanged
  [0, 1, 3].forEach(i => assert.deepEqual(f.expenses.grid[i], before[i]));
  assert.equal(f.expenses.grid[2][2], 14.25);
  assert.equal(f.expenses.grid[2][4], 'Diner Z');
  assert.equal(f.expenses.grid[2][1], 'Lunch');
});

t('edit refuses when the row no longer matches what the site saw', () => {
  const f = fixture(), ctx = load(f.sheets), before = snap(f.expenses);
  const r = post(ctx, { action: 'edit', target: 'Expenses', row: 3, expect: exp('Coffee', 4.5, '2026-10-01'), changes: { Amount: 999 } });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'row changed');
  assert.equal(snap(f.expenses), before);
  assert.equal(f.expenses.writes.length, 0);
});

t('edit skips formula cells and never touches Timestamp', () => {
  const f = fixture({ withFormula: true }), ctx = load(f.sheets);
  const r = post(ctx, { action: 'edit', target: 'Expenses', row: 3, expect: exp('Lunch', 12, '2026-10-02'), changes: { Amount: 50, Timestamp: 'x', Nope: 1 } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.updated, []);
  assert.deepEqual(r.skipped.sort(), ['Amount', 'Nope', 'Timestamp'].sort());
  assert.equal(f.expenses.writes.length, 0);
});

t('delete removes exactly the one selected row and nothing else', () => {
  const f = fixture(), ctx = load(f.sheets);
  const r = post(ctx, { action: 'delete', target: 'Expenses', row: 3, expect: exp('Lunch', 12, '2026-10-02') });
  assert.equal(r.ok, true);
  assert.deepEqual(f.expenses.deleted, [3]);
  assert.deepEqual(f.expenses.grid.map(x => x[1]), ['Item Purchased', 'Coffee', 'Socks']);
});

t('delete refuses a row that moved (retry after a delete cannot remove a neighbour)', () => {
  const f = fixture(), ctx = load(f.sheets);
  const req = { action: 'delete', target: 'Expenses', row: 3, expect: exp('Lunch', 12, '2026-10-02') };
  assert.equal(post(ctx, req).ok, true);
  const again = post(ctx, req);                       // row 3 is now "Socks"
  assert.equal(again.ok, false);
  assert.equal(again.error, 'row changed');
  assert.deepEqual(f.expenses.deleted, [3]);
  assert.equal(f.expenses.grid.length, 3);
});

t('delete refuses a row that contains formulas', () => {
  const f = fixture({ withFormula: true }), ctx = load(f.sheets), before = snap(f.expenses);
  const r = post(ctx, { action: 'delete', target: 'Expenses', row: 3, expect: exp('Lunch', 12, '2026-10-02') });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'row has formulas');
  assert.equal(snap(f.expenses), before);
  assert.equal(f.expenses.deleted.length, 0);
});

t('protected tabs can never be edited or deleted', () => {
  const f = fixture(), ctx = load(f.sheets), before = snap(f.master);
  ['edit', 'delete'].forEach(action => {
    const r = post(ctx, { action, target: 'Master Inventory', row: 2, expect: { Model: 'iPhone 12', IMEI: '111' }, changes: { Model: 'X' } });
    assert.equal(r.ok, false);
    assert.match(r.error, /tab not allowed/);
  });
  assert.equal(snap(f.master), before);
  assert.equal(f.master.deleted.length, 0);
});

t('bad rows and weak guards are refused', () => {
  const f = fixture(), ctx = load(f.sheets), before = snap(f.expenses);
  const ok = exp('Lunch', 12, '2026-10-02');
  [{ row: 1, expect: ok }, { row: 0, expect: ok }, { row: 99, expect: ok }, { row: 'x', expect: ok }, { row: 2.5, expect: ok },
   { row: 3, expect: {} }, { row: 3, expect: { Amount: 12 } }, { row: 3, expect: { Amount: 12, Missing: 'z' } }].forEach(extra => {
    ['edit', 'delete'].forEach(action => {
      const r = post(ctx, Object.assign({ action, target: 'Expenses', changes: { Amount: 1 } }, extra));
      assert.equal(r.ok, false, JSON.stringify(extra));
    });
  });
  assert.equal(snap(f.expenses), before);
  assert.equal(f.expenses.deleted.length, 0);
  assert.equal(f.expenses.writes.length, 0);
});

t('an old-style request (tab + values) still only adds, and edit/delete never reach the add path', () => {
  const f = fixture(), ctx = load(f.sheets);
  const r = post(ctx, { action: 'delete', tab: 'Expenses', row: 3 });   // wrong field names: must not add or delete anything
  assert.equal(r.ok, false);
  assert.equal(f.expenses.deleted.length, 0);
  assert.equal(f.expenses.grid.length, 4);
});

console.log(`\n${n} checks passed`);
