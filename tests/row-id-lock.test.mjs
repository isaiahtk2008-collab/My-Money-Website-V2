// Run with: node tests/row-id-lock.test.mjs
// Loads apps-script.gs with a mocked Google Sheet and proves edit/delete can find a row by its Row ID (even after rows above it were
// deleted), still run the `expect` check as a second lock, refuse a missing / duplicate / blank ID, leave the old row-number path and
// the add path exactly as they were, and that reading (and the check report) never writes anything.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const code = fs.readFileSync(path.join(here, '..', 'apps-script.gs'), 'utf8');

function makeSheet(name, grid, formulas = {}, maxRows = grid.length) {
  const writes = [], deleted = [], inserted = [];
  const sheet = {
    name, grid, formulas, writes, deleted, inserted, maxRows,
    getName: () => name,
    getLastRow: () => grid.length,
    getLastColumn: () => Math.max(0, ...grid.map(r => r.length)),
    getMaxRows: () => sheet.maxRows,
    insertRowsAfter: (after, n) => { inserted.push([after, n]); for (let i = 0; i < n; i++) grid.push([]); sheet.maxRows += n; },
    deleteRow: r => { deleted.push(r); grid.splice(r - 1, 1); sheet.maxRows -= 1; },
    appendRow: row => { grid.push(row.slice()); },
    getRange(r, c, nr = 1, nc = 1) {
      return {
        getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => { const v = (grid[r - 1 + i] || [])[c - 1 + j]; return v === undefined ? '' : v; })),
        getFormula: () => formulas[r + ',' + c] || '',
        getValue: () => { const v = (grid[r - 1] || [])[c - 1]; return v === undefined ? '' : v; },
        setValue: v => { writes.push([r, c, v]); while (grid.length < r) grid.push([]); grid[r - 1][c - 1] = v; },
        setValues: vals => { vals.forEach((rowVals, i) => rowVals.forEach((v, j) => { while (grid.length < r + i) grid.push([]); grid[r - 1 + i][c - 1 + j] = v; })); }
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
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheets: () => sheets, getSpreadsheetTimeZone: () => 'UTC', insertSheet: name => { const s = makeSheet(name, []); sheets.push(s); return s; } }) },
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
const get = (ctx, parameter) => parse(ctx.doGet({ parameter }));
const snap = sheet => JSON.stringify(sheet.grid);
const untouched = (sheet, before) => {
  assert.equal(snap(sheet), before);
  assert.equal(sheet.writes.length, 0);
  assert.equal(sheet.deleted.length, 0);
  assert.equal(sheet.inserted.length, 0);
};

const HEAD = ['Timestamp', 'Row ID', 'Item Purchased', 'Amount', 'Date of Purchase', 'Establishment'];
// Rows 2 and 3 are IDENTICAL except for their Row ID. Row numbers: rA1=2, rB2=3, rC3=4, rD4=5, rE5=6.
const baseGrid = () => [
  HEAD,
  ['', 'rA1', 'Coffee', 4.5, '2026-10-01', 'Cafe A'],
  ['', 'rB2', 'Coffee', 4.5, '2026-10-01', 'Cafe A'],
  ['', 'rC3', 'Lunch', 12, '2026-10-02', 'Diner B'],
  ['', 'rD4', 'Socks', 9.99, '2026-10-03', 'Shop C'],
  ['', 'rE5', 'Cable', 7, '2026-10-04', 'Shop D']
];
function fixture(grid = baseGrid()) {
  const expenses = makeSheet('Expenses', grid, {}, 10);
  const master = makeSheet('Master Inventory', [['Model', 'IMEI', 'Device Label'], ['iPhone 12', '111', 'P1']], { '2,1': '=1' });
  return { expenses, master, sheets: [expenses, master] };
}
const COFFEE = { 'Item Purchased': 'Coffee', Amount: 4.5, 'Date of Purchase': '2026-10-01' };
const LUNCH = { 'Item Purchased': 'Lunch', Amount: 12, 'Date of Purchase': '2026-10-02' };
const CABLE = { 'Item Purchased': 'Cable', Amount: 7, 'Date of Purchase': '2026-10-04' };

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok -', name); };

t('edit by Row ID hits the right row, even after rows above it were deleted (old row number is ignored)', () => {
  const f = fixture(), ctx = load(f.sheets);
  // delete the two Coffee rows by ID; the Cable row moves from sheet row 6 up to row 4
  assert.equal(post(ctx, { action: 'delete', target: 'Expenses', rowId: 'rA1', expect: COFFEE }).row, 2);
  assert.equal(post(ctx, { action: 'delete', target: 'Expenses', rowId: 'rB2', expect: COFFEE }).row, 2);
  assert.deepEqual(f.expenses.grid.map(r => r[1]), ['Row ID', 'rC3', 'rD4', 'rE5']);
  const before = JSON.parse(snap(f.expenses));
  const r = post(ctx, { action: 'edit', target: 'Expenses', row: 6, rowId: 'rE5', expect: CABLE, changes: { Amount: 8.25 } });   // row 6 is the stale number
  assert.equal(r.ok, true);
  assert.equal(r.row, 4);
  assert.deepEqual(r.updated, ['Amount']);
  assert.deepEqual(f.expenses.writes, [[4, 4, 8.25]]);
  [0, 1, 2].forEach(i => assert.deepEqual(f.expenses.grid[i], before[i]));
  assert.equal(f.expenses.grid[3][3], 8.25);
});

t('the row number is ignored when rowId is sent (a wrong number cannot redirect the edit)', () => {
  const f = fixture(), ctx = load(f.sheets);
  const r = post(ctx, { action: 'edit', target: 'Expenses', row: 2, rowId: 'rE5', expect: CABLE, changes: { Establishment: 'Shop Z' } });
  assert.equal(r.ok, true);
  assert.equal(r.row, 6);
  assert.deepEqual(f.expenses.writes, [[6, 6, 'Shop Z']]);
  assert.equal(f.expenses.grid[1][5], 'Cafe A');
});

t('two identical rows with different Row IDs are told apart (edit and delete)', () => {
  const f = fixture(), ctx = load(f.sheets);
  const e = post(ctx, { action: 'edit', target: 'Expenses', rowId: 'rB2', expect: COFFEE, changes: { Establishment: 'Cafe B' } });
  assert.equal(e.ok, true);
  assert.equal(e.row, 3);
  assert.equal(f.expenses.grid[1][5], 'Cafe A');
  assert.equal(f.expenses.grid[2][5], 'Cafe B');
  assert.ok(f.expenses.writes.every(w => w[0] === 3));
  const d = post(ctx, { action: 'delete', target: 'Expenses', rowId: 'rA1', expect: COFFEE });
  assert.equal(d.ok, true);
  assert.deepEqual(f.expenses.deleted, [2]);
  assert.deepEqual(f.expenses.grid.map(r => r[1]), ['Row ID', 'rB2', 'rC3', 'rD4', 'rE5']);
  assert.equal(f.expenses.grid[1][5], 'Cafe B');
});

t('a Row ID that is not in the sheet is refused and nothing changes', () => {
  const f = fixture(), ctx = load(f.sheets), before = snap(f.expenses);
  ['edit', 'delete'].forEach(action => {
    const r = post(ctx, { action, target: 'Expenses', row: 4, rowId: 'rZZ9', expect: LUNCH, changes: { Amount: 1 } });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'row id not found');
  });
  untouched(f.expenses, before);
});

t('a blank, odd-typed or case-different Row ID is refused and nothing changes', () => {
  const f = fixture(), ctx = load(f.sheets), before = snap(f.expenses);
  [['', 'bad row id'], ['   ', 'bad row id'], [true, 'bad row id'], [{ a: 1 }, 'bad row id'], [['rC3'], 'bad row id'], ['rc3', 'row id not found']].forEach(([rowId, error]) => {
    ['edit', 'delete'].forEach(action => {
      const r = post(ctx, { action, target: 'Expenses', row: 4, rowId, expect: LUNCH, changes: { Amount: 1 } });
      assert.equal(r.ok, false, JSON.stringify(rowId));
      assert.equal(r.error, error, JSON.stringify(rowId));
    });
  });
  untouched(f.expenses, before);
});

t('a duplicate Row ID is refused for both rows and nothing changes', () => {
  const grid = baseGrid(); grid[3][1] = 'rA1';                       // rows 2 and 4 now share "rA1"
  const f = fixture(grid), ctx = load(f.sheets), before = snap(f.expenses);
  [{ expect: COFFEE }, { expect: LUNCH }].forEach(extra => {
    ['edit', 'delete'].forEach(action => {
      const r = post(ctx, Object.assign({ action, target: 'Expenses', rowId: 'rA1', changes: { Amount: 1 } }, extra));
      assert.equal(r.ok, false);
      assert.equal(r.error, 'row id not unique');
    });
  });
  untouched(f.expenses, before);
});

t('a tab with no Row ID column (or two) refuses a rowId request', () => {
  const noCol = fixture([HEAD.filter(h => h !== 'Row ID'), ['', 'Coffee', 4.5, '2026-10-01', 'Cafe A'], ['', 'Lunch', 12, '2026-10-02', 'Diner B']]);
  const twoCol = fixture([HEAD.concat('Row ID'), ['', 'rA1', 'Coffee', 4.5, '2026-10-01', 'Cafe A', 'rA1'], ['', 'rB2', 'Lunch', 12, '2026-10-02', 'Diner B', 'rB2']]);
  [noCol, twoCol].forEach(f => {
    const ctx = load(f.sheets), before = snap(f.expenses);
    ['edit', 'delete'].forEach(action => {
      const r = post(ctx, { action, target: 'Expenses', rowId: 'rA1', expect: COFFEE, changes: { Amount: 1 } });
      assert.equal(r.ok, false);
      assert.equal(r.error, 'tab needs exactly one Row ID column');
    });
    untouched(f.expenses, before);
  });
});

t('a stale expect is refused even though the Row ID matches (second lock)', () => {
  const f = fixture(), ctx = load(f.sheets), before = snap(f.expenses);
  ['edit', 'delete'].forEach(action => {
    const r = post(ctx, { action, target: 'Expenses', rowId: 'rC3', expect: COFFEE, changes: { Amount: 999 } });   // rC3 is Lunch, not Coffee
    assert.equal(r.ok, false);
    assert.equal(r.error, 'row changed');
  });
  // the sheet changed after the site loaded it: right ID, old amount
  f.expenses.grid[3][3] = 13;
  const after = snap(f.expenses);
  const r = post(ctx, { action: 'edit', target: 'Expenses', rowId: 'rC3', expect: LUNCH, changes: { Amount: 999 } });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'row changed');
  assert.notEqual(before, after);
  untouched(f.expenses, after);
});

t('rowId requests still need a 2-column expect and a real tab', () => {
  const f = fixture(), ctx = load(f.sheets), before = snap(f.expenses);
  [{ expect: {} }, { expect: { Amount: 12 } }, { expect: { Amount: 12, Missing: 'z' } }, {}].forEach(extra => {
    const r = post(ctx, Object.assign({ action: 'edit', target: 'Expenses', rowId: 'rC3', changes: { Amount: 1 } }, extra));
    assert.equal(r.ok, false, JSON.stringify(extra));
  });
  const m = post(ctx, { action: 'edit', target: 'Master Inventory', rowId: 'rC3', expect: { Model: 'iPhone 12', IMEI: '111' }, changes: { Model: 'X' } });
  assert.equal(m.ok, false);
  assert.match(m.error, /tab not allowed/);
  untouched(f.expenses, before);
});

t('the old row-number path is unchanged (works, and still refuses a moved or bad row)', () => {
  const f = fixture(), ctx = load(f.sheets);
  const ok = post(ctx, { action: 'edit', target: 'Expenses', row: 4, expect: LUNCH, changes: { Amount: 14.25 } });
  assert.equal(ok.ok, true);
  assert.equal(ok.row, 4);
  assert.deepEqual(f.expenses.writes, [[4, 4, 14.25]]);
  const before = snap(f.expenses), writes = f.expenses.writes.length;
  const moved = post(ctx, { action: 'delete', target: 'Expenses', row: 4, expect: COFFEE });
  assert.equal(moved.error, 'row changed');
  [{ row: 1 }, { row: 0 }, { row: 99 }, { row: 'x' }, { row: 2.5 }, {}, { row: 4, rowId: null }].forEach((extra, i) => {
    const r = post(ctx, Object.assign({ action: 'delete', target: 'Expenses', expect: i === 6 ? COFFEE : LUNCH }, extra));
    assert.equal(r.ok, false, JSON.stringify(extra));
    if (i < 6) assert.equal(r.error, 'bad row', JSON.stringify(extra));      // rowId: null counts as "no rowId", so the row-number rules apply
  });
  assert.equal(snap(f.expenses), before);
  assert.equal(f.expenses.writes.length, writes);
  assert.equal(f.expenses.deleted.length, 0);
  const del = post(ctx, { action: 'delete', target: 'Expenses', row: 3, expect: COFFEE });
  assert.equal(del.ok, true);
  assert.deepEqual(f.expenses.deleted, [3]);
});

t('the old add path is unchanged (still only adds one row, and still stamps a new Row ID)', () => {
  const f = fixture(), ctx = load(f.sheets);
  const before = JSON.parse(snap(f.expenses));
  const r = post(ctx, { tab: 'Expenses', id: 'abc-1', values: { 'Item Purchased': 'Mouse', Amount: 20, 'Date of Purchase': '2026-10-05' } });
  assert.equal(r.ok, true);
  assert.equal(r.row, 7);
  assert.match(r.rowId, /^r[a-z0-9]+$/);
  assert.equal(f.expenses.deleted.length, 0);
  before.forEach((row, i) => assert.deepEqual(f.expenses.grid[i], row));
  assert.equal(f.expenses.grid[6][1], r.rowId);
  assert.equal(f.expenses.grid[6][2], 'Mouse');
  assert.ok(f.expenses.writes.every(w => w[0] === 7));
  const again = post(ctx, { tab: 'Expenses', id: 'abc-1', values: { 'Item Purchased': 'Mouse', Amount: 20 } });
  assert.equal(again.dup, true);
  assert.equal(f.expenses.grid.length, 7);
});

t('action=read writes nothing and returns Row ID, _row and every old key', () => {
  const f = fixture(), ctx = load(f.sheets), before = snap(f.expenses), masterBefore = snap(f.master);
  const r = get(ctx, { action: 'read' });
  assert.equal(r.ok, true);
  const rows = r.tabs.Expenses.rows;
  assert.equal(rows.length, 5);
  assert.deepEqual(rows.map(x => x['Row ID']), ['rA1', 'rB2', 'rC3', 'rD4', 'rE5']);
  assert.deepEqual(rows.map(x => x._row), [2, 3, 4, 5, 6]);
  assert.equal(rows[2]['Item Purchased'], 'Lunch');
  assert.equal(rows[2].Amount, 12);
  assert.equal(rows[2]['Date of Purchase'], '2026-10-02');
  assert.equal(rows[2].Establishment, 'Diner B');
  assert.deepEqual(r.tabs.Expenses.headers, HEAD);
  // _row is the real sheet row: it points at the same row that an edit by number would hit
  const e = post(ctx, { action: 'edit', target: 'Expenses', row: rows[4]._row, expect: CABLE, changes: { Amount: 7.5 } });
  assert.equal(e.ok, true);
  assert.equal(e.row, 6);
  // flat view still works; read and check wrote nothing
  const flat = get(ctx, { action: 'read', flat: '1' });
  assert.equal(flat.data.filter(x => x._tab === 'Expenses').length, 5);
  const f2 = fixture(), ctx2 = load(f2.sheets), b2 = snap(f2.expenses);
  get(ctx2, { action: 'read' }); get(ctx2, { action: 'read', flat: '1' }); get(ctx2, { action: 'check' });
  untouched(f2.expenses, b2);
  untouched(f2.master, masterBefore);
  assert.equal(snap(f.master), masterBefore);
  assert.notEqual(snap(f.expenses), before);   // (only the explicit edit above changed f.expenses)
});

t('a column already called _row is not overwritten by the added _row', () => {
  const f = fixture([['Item Purchased', 'Amount', 'Date of Purchase', '_row'], ['Coffee', 4.5, '2026-10-01', 'mine']]), ctx = load(f.sheets);
  const r = get(ctx, { action: 'read' });
  assert.equal(r.tabs.Expenses.rows[0]._row, 'mine');
});

t('check reports rows missing a Row ID per tab (null when the tab has no Row ID column) and writes nothing', () => {
  const grid = baseGrid();
  grid[2][1] = '';                                  // real data row, empty Row ID  -> counted
  grid.splice(4, 0, ['', '', '', '', '', '']);      // blank gap row in the middle  -> not counted
  const f = fixture(grid), ctx = load(f.sheets), before = snap(f.expenses), masterBefore = snap(f.master);
  const r = get(ctx, { action: 'check' });
  assert.equal(r.ok, true);
  assert.equal(r.tabs.Expenses.hasRowId, true);
  assert.equal(r.tabs.Expenses.missingRowId, 1);
  assert.equal(r.tabs.Expenses.rows, 6);
  assert.equal(r.tabs.Expenses.columns, 6);
  assert.equal(r.tabs.Expenses.found, true);
  assert.deepEqual(r.tabs.Expenses.problems, []);
  assert.equal(r.tabs.Phones.hasRowId, false);
  assert.equal(r.tabs.Phones.missingRowId, null);
  assert.equal(r.tabs.PCs.found, false);            // a tab that does not exist is still reported, not an error
  assert.equal(r.tabs.PCs.missingRowId, null);
  untouched(f.expenses, before);
  untouched(f.master, masterBefore);
});

console.log(`\n${n} checks passed`);
