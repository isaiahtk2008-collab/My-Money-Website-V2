// Run with: node tests/owed-tab.test.mjs
// Proves the single "Owed" tab (loans and deposits, told apart by a Type column) in apps-script.gs: rows can be added and edited (by Row ID, logged
// to the Edit Log) but never deleted, a missing tab fails cleanly and is never created, retries add nothing, and no other tab is ever touched.
// log write blocks the edit; Expenses behaves as before; and reading the new tabs writes nothing and creates no tab.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const code = fs.readFileSync(path.join(here, '..', 'apps-script.gs'), 'utf8');

function makeSheet(name, grid, formulas = {}, maxRows = grid.length) {
  const writes = [], deleted = [], inserted = [], appended = [];
  const sheet = {
    name, grid, formulas, writes, deleted, inserted, appended, maxRows,
    getName: () => name,
    getLastRow: () => grid.length,
    getLastColumn: () => Math.max(0, ...grid.map(r => r.length)),
    getMaxRows: () => sheet.maxRows,
    insertRowsAfter: (after, n) => { inserted.push([after, n]); for (let i = 0; i < n; i++) grid.push([]); sheet.maxRows += n; },
    deleteRow: r => { deleted.push(r); grid.splice(r - 1, 1); sheet.maxRows -= 1; },
    appendRow: row => { if (sheet.failAppend) throw new Error('boom'); appended.push(row); grid.push(row.slice()); },
    getRange(r, c, nr = 1, nc = 1) {
      return {
        getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => { const v = (grid[r - 1 + i] || [])[c - 1 + j]; return v === undefined ? '' : v; })),
        getFormula: () => formulas[r + ',' + c] || '',
        getValue: () => { const v = (grid[r - 1] || [])[c - 1]; return v === undefined ? '' : v; },
        setValue: v => { writes.push([r, c, v]); while (grid.length < r) grid.push([]); grid[r - 1][c - 1] = v; },
        setValues: vals => { vals.forEach((rowVals, i) => rowVals.forEach((v, j) => { while (grid.length < r + i) grid.push([]); grid[r - 1 + i][c - 1 + j] = v; })); writes.push(['setValues', r, c]); }
      };
    }
  };
  return sheet;
}

function load(sheets, opts = {}) {
  const props = {}, cache = {}, createdNames = [];
  const ss = {
    getSheets: () => sheets,
    getSpreadsheetTimeZone: () => 'UTC',
    insertSheet: name => {
      if (opts.failInsert) throw new Error('nope');
      const s = makeSheet(name, []);
      sheets.push(s);
      createdNames.push(name);
      return s;
    }
  };
  const ctx = {
    console,
    ContentService: { MimeType: { JSON: 'JSON' }, createTextOutput: s => ({ text: s, setMimeType(m) { this.mime = m; return this; } }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    CacheService: { getScriptCache: () => ({ get: k => cache[k] || null, put: (k, v) => { cache[k] = v; } }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] || null, setProperty: (k, v) => { props[k] = v; } }) },
    Utilities: { formatDate: (d, tz, f) => (f === 'yyyy-MM-dd' ? d.toISOString().slice(0, 10) : d.toISOString().slice(11, 19)) }
  };
  vm.createContext(ctx);
  ctx.__created = createdNames;
  vm.runInContext(code, ctx);
  return ctx;
}

const parse = out => { assert.equal(out.mime, 'JSON'); return JSON.parse(out.text); };
const post = (ctx, body) => parse(ctx.doPost({ postData: { contents: JSON.stringify(body) } }));
const get = (ctx, parameter) => parse(ctx.doGet({ parameter }));
const snap = sheet => JSON.stringify(sheet.grid);

const EDIT_ONLY = [
  'Form Responses - Bought',
  'Form Responses - PCs',
  'Bought Access - Form',
  'Form Responses - Sold',
  'Form Responses - Sold PCs',
  'Sold Access - Form'
];
const LOG_HEAD = ['Timestamp', 'Tab', 'Row ID', 'Column', 'Old value', 'New value', 'Action'];

// ---- Owed tab tests (body drafted by Gemini flash, then reviewed and corrected) ----
// Dates written BY THE SCRIPT come from the script's own VM realm, so `instanceof Date` is unreliable here.
const isDate = v => Object.prototype.toString.call(v) === '[object Date]';

const makeOwed = (opts = {}) => {
  const sheets = [];
  if (!opts.noOwed) {
    sheets.push(makeSheet('Owed', [
      ['Timestamp', 'Row ID', 'Type', 'Person', 'Phone / Email', 'Item / Device', 'Total Amount', 'Amount Paid', 'Date Out', 'Due Date', 'Status', 'Date Closed', 'Notes'],
      ['', 'O1', 'Loan', 'Sam', '555-0100', 'ThinkPad T480', 200, 0, '2026-01-01', '2026-02-01', '', '', 'first loan'],
      ['', 'O2', 'Loan', 'Alex', '555-0101', 'Dell XPS 13', 50, 0, '2026-01-02', '2026-02-02', '', '', 'second loan'],
      ['', 'O3', 'Deposit', 'Jordan', '555-0102', 'Surface Laptop 4', 900, 200, '2026-01-03', '2026-01-17', '', '', 'deposit paid']
    ]));
  }
  sheets.push(makeSheet('Expenses', [
    ['Timestamp', 'Row ID', 'Item Purchased', 'Amount', 'Date of Purchase', 'Establishment'],
    ['', 'E1', 'Tape', 10, '2026-01-01', 'Store']
  ]));
  sheets.push(makeSheet('Master Inventory', [
    ['Timestamp', 'Row ID', 'Model', 'IMEI', 'Price'],
    ['', 'M1', 'iPhone 11', '123456789012345', 300]
  ]));
  sheets.push(makeSheet('Summary', [['Metric', 'Value'], ['Total', 100]]));
  // The shared mock has no getFormulas (the Row ID backfill needs it). These fixtures have no formulas, so every cell reports none.
  sheets.forEach(sh => {
    const orig = sh.getRange;
    sh.getRange = (r, c, nr = 1, nc = 1) => {
      const rg = orig(r, c, nr, nc);
      rg.getFormulas = () => Array.from({ length: nr }, () => Array(nc).fill(''));
      return rg;
    };
  });
  return sheets;
};
const byName = (sheets, name) => sheets.find(s => s.name === name);
const snapAll = sheets => sheets.map(s => snap(s));
const unchanged = (sheets, before) => sheets.forEach((s, i) => assert.equal(snap(s), before[i]));

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok -', name); };

t('Owed: adding a Loan lands in the next free row with a generated Row ID; no other tab changes', () => {
  const sheets = makeOwed();
  const owed = byName(sheets, 'Owed');
  const others = sheets.filter(s => s !== owed), before = snapAll(others);
  const ctx = load(sheets);
  const res = post(ctx, { id: 'x1', tab: 'Owed', values: { Type: 'Loan', Person: 'Pat', 'Total Amount': 300 } });
  assert.equal(res.ok, true);
  assert.equal(res.row, 5);
  assert.deepEqual(res.unmatched, []);
  assert.ok(typeof res.rowId === 'string' && res.rowId.length > 0);
  assert.equal(owed.grid.length, 5);
  const row = owed.grid[4];
  assert.ok(isDate(row[0]));
  assert.equal(row[1], res.rowId);
  assert.equal(row[2], 'Loan');
  assert.equal(row[3], 'Pat');
  assert.equal(row[6], 300);
  others.forEach((s, i) => assert.equal(snap(s), before[i]));
  assert.deepEqual(ctx.__created, []);
});

t('Owed: adding a Deposit stores Type and the $date fields as real dates', () => {
  const sheets = makeOwed();
  const owed = byName(sheets, 'Owed');
  const ctx = load(sheets);
  const res = post(ctx, { id: 'x2', tab: 'Owed', values: { Type: 'Deposit', Person: 'Taylor', 'Total Amount': 500, 'Amount Paid': 100, 'Date Out': { $date: '2026-10-30' }, 'Due Date': { $date: '2026-11-15' } } });
  assert.equal(res.ok, true);
  assert.equal(res.row, 5);
  const row = owed.grid[4];
  assert.equal(row[2], 'Deposit');
  assert.equal(row[7], 100);
  assert.ok(isDate(row[8]) && isDate(row[9]));
  assert.deepEqual([row[8].getFullYear(), row[8].getMonth(), row[8].getDate()], [2026, 9, 30]);
  assert.deepEqual([row[9].getFullYear(), row[9].getMonth(), row[9].getDate()], [2026, 10, 15]);
});

t('Owed: a retry with the same request id adds nothing', () => {
  const sheets = makeOwed();
  const owed = byName(sheets, 'Owed');
  const ctx = load(sheets);
  const body = { id: 'x3', tab: 'Owed', values: { Type: 'Loan', Person: 'Sam', 'Total Amount': 100 } };
  const first = post(ctx, body);
  assert.equal(first.ok, true);
  assert.equal(first.dup, undefined);
  const len = owed.grid.length;
  const second = post(ctx, body);
  assert.equal(second.ok, true);
  assert.equal(second.dup, true);
  assert.equal(owed.grid.length, len);
});

t('Owed: adding when the tab does not exist yet fails cleanly, creates no tab, changes nothing', () => {
  const sheets = makeOwed({ noOwed: true });
  const before = snapAll(sheets), count = sheets.length;
  const ctx = load(sheets);
  const res = post(ctx, { id: 'x4', tab: 'Owed', values: { Type: 'Loan', Person: 'Pat', 'Total Amount': 300 } });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'no tab: Owed');
  assert.deepEqual(ctx.__created, []);
  assert.equal(sheets.length, count);
  unchanged(sheets, before);
});

t('Owed: an edit by Row ID writes the cells and logs old and new values in a new Edit Log; the Deposit row is untouched', () => {
  const sheets = makeOwed();
  const owed = byName(sheets, 'Owed');
  const depBefore = JSON.stringify(owed.grid[3]), o2Before = JSON.stringify(owed.grid[2]);
  const ctx = load(sheets);
  const res = post(ctx, { action: 'edit', target: 'Owed', rowId: 'O1', expect: { Type: 'Loan', Person: 'Sam', 'Total Amount': 200 }, changes: { Status: 'Returned', 'Amount Paid': 200 } });
  assert.equal(res.ok, true);
  assert.deepEqual(res.updated.slice().sort(), ['Amount Paid', 'Status']);
  assert.equal(owed.grid[1][7], 200);
  assert.equal(owed.grid[1][10], 'Returned');
  assert.deepEqual(ctx.__created, ['Edit Log']);
  const log = byName(sheets, 'Edit Log');
  assert.ok(log);
  assert.deepEqual(log.grid[0], LOG_HEAD);
  assert.equal(log.grid.length, 3);
  const logRows = log.grid.slice(1);   // logged in the order the changes were sent, so look each one up by column
  logRows.forEach(r => { assert.ok(isDate(r[0])); assert.equal(r[1], 'Owed'); assert.equal(r[2], 'O1'); assert.equal(r[6], 'edit'); });
  const st = logRows.find(r => r[3] === 'Status'), pd = logRows.find(r => r[3] === 'Amount Paid');
  assert.deepEqual([st[4], st[5]], ['', 'Returned']);
  assert.deepEqual([pd[4], pd[5]], [0, 200]);
  assert.equal(JSON.stringify(owed.grid[3]), depBefore);
  assert.equal(JSON.stringify(owed.grid[2]), o2Before);
});

t('Owed: an edit whose expect no longer matches the live row is refused; nothing is written or logged', () => {
  const sheets = makeOwed();
  const before = snapAll(sheets);
  const ctx = load(sheets);
  const res = post(ctx, { action: 'edit', target: 'Owed', rowId: 'O1', expect: { Type: 'Loan', Person: 'Sam', 'Total Amount': 999 }, changes: { Status: 'Returned' } });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'row changed');
  assert.deepEqual(ctx.__created, []);
  sheets.forEach(s => assert.deepEqual(s.writes, []));
  assert.equal(byName(sheets, 'Edit Log'), undefined);
  unchanged(sheets, before);
});

t('Owed: an edit with only one expect column is refused and nothing is written', () => {
  const sheets = makeOwed();
  const before = snapAll(sheets);
  const ctx = load(sheets);
  const res = post(ctx, { action: 'edit', target: 'Owed', rowId: 'O1', expect: { Person: 'Sam' }, changes: { Status: 'Returned' } });
  assert.equal(res.ok, false);
  assert.ok(String(res.error).includes('expect needs at least 2 columns'));
  assert.deepEqual(ctx.__created, []);
  sheets.forEach(s => assert.deepEqual(s.writes, []));
  unchanged(sheets, before);
});

t('Owed: a Deposit can be marked Picked Up with a Date Closed, and an unknown Row ID is refused', () => {
  const sheets = makeOwed();
  const owed = byName(sheets, 'Owed');
  const ctx = load(sheets);
  const bad = post(ctx, { action: 'edit', target: 'Owed', rowId: 'O999', expect: { Person: 'Jordan', 'Total Amount': 900 }, changes: { Status: 'Picked Up' } });
  assert.equal(bad.ok, false);
  assert.equal(owed.grid[3][10], '');
  assert.equal(byName(sheets, 'Edit Log'), undefined);
  const ok = post(ctx, { action: 'edit', target: 'Owed', rowId: 'O3', expect: { Type: 'Deposit', Person: 'Jordan', 'Total Amount': 900 }, changes: { Status: 'Picked Up', 'Date Closed': { $date: '2026-10-31' } } });
  assert.equal(ok.ok, true);
  assert.equal(owed.grid[3][10], 'Picked Up');
  assert.ok(isDate(owed.grid[3][11]));
  assert.deepEqual([owed.grid[3][11].getFullYear(), owed.grid[3][11].getMonth(), owed.grid[3][11].getDate()], [2026, 9, 31]);
  assert.equal(owed.grid[1][10], '');   // the loans are untouched
});

t('Owed: delete is refused (tab not allowed) for a Loan row and for a Deposit row; nothing changes', () => {
  const sheets = makeOwed();
  const before = snapAll(sheets);
  const ctx = load(sheets);
  const a = post(ctx, { action: 'delete', target: 'Owed', rowId: 'O1', expect: { Person: 'Sam', 'Total Amount': 200 } });
  const b = post(ctx, { action: 'delete', target: 'Owed', rowId: 'O3', expect: { Person: 'Jordan', 'Total Amount': 900 } });
  [a, b].forEach(r => { assert.equal(r.ok, false); assert.ok(String(r.error).includes('tab not allowed')); });
  sheets.forEach(s => assert.deepEqual(s.deleted, []));
  unchanged(sheets, before);
});

t('Owed: reading returns the rows with row numbers; an absent tab comes back as missing and is not created', () => {
  const ctx1 = load(makeOwed());
  const r1 = get(ctx1, { action: 'read' });
  assert.equal(r1.ok, true);
  assert.deepEqual(r1.tabs.Owed.rows.map(r => [r['Row ID'], r._row, r.Type]), [['O1', 2, 'Loan'], ['O2', 3, 'Loan'], ['O3', 4, 'Deposit']]);
  assert.equal(r1.tabs.Owed.missing, undefined);
  assert.equal(get(ctx1, { action: 'check' }).ok, true);

  const sheets2 = makeOwed({ noOwed: true });
  const before = snapAll(sheets2), count = sheets2.length;
  const ctx2 = load(sheets2);
  const r2 = get(ctx2, { action: 'read' });
  assert.equal(r2.ok, true);
  assert.equal(get(ctx2, { action: 'check' }).ok, true);
  assert.equal(r2.tabs.Owed.missing, true);
  assert.deepEqual(r2.tabs.Owed.rows, []);
  assert.deepEqual(ctx2.__created, []);
  assert.equal(sheets2.length, count);
  unchanged(sheets2, before);
});

t('Owed: the Row ID backfill fills only the one empty Row ID on a row that has data, and nothing else', () => {
  const sheets = makeOwed();
  const owed = byName(sheets, 'Owed');
  owed.grid.push(['', '', 'Loan', 'Casey', '555-0103', 'iPad Pro', 400, 0, '2026-01-04', '2026-02-04', '', '', 'backfill me']);
  const others = sheets.filter(s => s !== owed), beforeOthers = snapAll(others);
  const first3 = JSON.stringify(owed.grid.slice(0, 4));
  const rest = owed.grid[4].slice(2);
  const ctx = load(sheets);
  const res = post(ctx, { action: 'backfill' });
  assert.equal(res.ok, true);
  assert.equal(res.total, 1);
  assert.equal(JSON.stringify(owed.grid.slice(0, 4)), first3);
  assert.ok(typeof owed.grid[4][1] === 'string' && owed.grid[4][1].length > 0);
  assert.deepEqual(owed.grid[4].slice(2), rest);
  others.forEach((s, i) => assert.equal(snap(s), beforeOthers[i]));
});

t('Owed: the tab lists allow add and edit only, never delete or trade; the old Loans/Deposits names are gone', () => {
  const ctx = load(makeOwed());
  const list = name => JSON.parse(vm.runInContext('JSON.stringify(' + name + ')', ctx));
  const names = ['ALLOWED_TABS', 'EDIT_ONLY_TABS', 'EDITABLE_TABS', 'SALE_DELETE_TABS', 'TRADE_SOLD_TABS', 'TRADE_BOUGHT_TABS'];
  assert.ok(list('ALLOWED_TABS').includes('Owed'));
  assert.ok(list('EDIT_ONLY_TABS').includes('Owed'));
  assert.deepEqual(list('EDITABLE_TABS'), ['Expenses']);
  ['SALE_DELETE_TABS', 'TRADE_SOLD_TABS', 'TRADE_BOUGHT_TABS'].forEach(k => assert.ok(!list(k).includes('Owed')));
  names.forEach(k => { assert.ok(!list(k).includes('Loans')); assert.ok(!list(k).includes('Deposits')); });
});

console.log(`\n${n} checks passed`);
