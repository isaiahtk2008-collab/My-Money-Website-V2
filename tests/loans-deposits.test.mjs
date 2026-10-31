// Run with: node tests/loans-deposits.test.mjs
// Proves the Loans and Deposits tabs in apps-script.gs: rows can be added and edited (by Row ID, logged to the Edit Log) but never deleted,
// a missing tab fails cleanly and is never created, retries add nothing, and no other tab is ever touched.
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

// ---- Loans and Deposits tests (body drafted by Gemini flash, reviewed and corrected) ----
// Dates written BY THE SCRIPT come from the script's own VM realm, so `instanceof Date` is unreliable here.
const isDate = v => Object.prototype.toString.call(v) === '[object Date]';
const LOAN_HEAD = ['Timestamp', 'Row ID', 'Borrower', 'Phone / Email', 'Item / Device', 'Amount Loaned', 'Amount Repaid', 'Date Loaned', 'Return By', 'Status', 'Date Closed', 'Notes'];
const DEP_HEAD = ['Timestamp', 'Row ID', 'Customer', 'Phone / Email', 'Device', 'Total Price', 'Deposit Paid', 'Date Deposit Taken', 'Pickup By', 'Status', 'Date Closed', 'Notes'];

function makeLD(opts = {}) {
  const sheets = [];
  if (!opts.noLoans) {
    sheets.push(makeSheet('Loans', [
      LOAN_HEAD,
      ['', 'L1', 'Sam', '555-0100', 'ThinkPad T480', 200, 0, '2026-01-01', '2026-02-01', '', '', 'first loan'],
      ['', 'L2', 'Alex', '555-0101', 'Dell XPS 13', 50, 0, '2026-01-02', '2026-02-02', '', '', 'second loan']
    ]));
  }
  if (!opts.noDeposits) {
    sheets.push(makeSheet('Deposits', [
      DEP_HEAD,
      ['', 'D1', 'Jordan', '555-0102', 'Surface Laptop 4', 900, 200, '2026-01-03', '2026-01-17', '', '', 'deposit paid']
    ]));
  }
  sheets.push(makeSheet('Expenses', [
    ['Timestamp', 'Row ID', 'Item Purchased', 'Amount', 'Date of Purchase', 'Establishment'],
    ['', 'E1', 'Tape', 15, '2026-01-04', 'Office Max']
  ]));
  sheets.push(makeSheet('Master Inventory', [
    ['Timestamp', 'Row ID', 'Model', 'IMEI', 'Price'],
    ['', 'M1', 'iPhone 13', '356938035643809', 450]
  ]));
  sheets.push(makeSheet('Summary', [['Metric', 'Value'], ['Active Loans', 2]]));
  // The shared mock has no getFormulas (the Row ID backfill needs it). These fixtures have no formulas, so every cell reports none.
  sheets.forEach(sh => { const orig = sh.getRange; sh.getRange = (r, c, nr = 1, nc = 1) => { const rg = orig(r, c, nr, nc); rg.getFormulas = () => Array.from({ length: nr }, () => Array(nc).fill('')); return rg; }; });
  return sheets;
}
const byName = (sheets, name) => sheets.find(s => s.name === name);
const snapAll = sheets => sheets.map(s => snap(s));
const unchanged = (sheets, before) => sheets.forEach((s, i) => assert.equal(snap(s), before[i]));

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok -', name); };

t('Loans: adding a row lands in the next free row with a generated Row ID and a Timestamp; no other tab changes', () => {
  const sheets = makeLD();
  const loans = byName(sheets, 'Loans');
  const others = sheets.filter(s => s !== loans), before = snapAll(others);
  const ctx = load(sheets);
  const res = post(ctx, { id: 'req-loan-1', tab: 'Loans', values: { Borrower: 'Pat', 'Amount Loaned': 300, 'Item / Device': 'iPad Pro', 'Phone / Email': '555-0199', Notes: 'test add' } });
  assert.equal(res.ok, true);
  assert.equal(res.row, 4);
  assert.deepEqual(res.unmatched, []);
  assert.ok(typeof res.rowId === 'string' && res.rowId.length > 0);
  assert.equal(loans.grid.length, 4);
  const row = loans.grid[3];
  assert.ok(isDate(row[0]));
  assert.equal(row[1], res.rowId);
  assert.equal(row[2], 'Pat');
  assert.equal(row[3], '555-0199');
  assert.equal(row[4], 'iPad Pro');
  assert.equal(row[5], 300);
  assert.equal(row[11], 'test add');
  others.forEach((s, i) => assert.equal(snap(s), before[i]));
  assert.equal(ctx.__created.length, 0);
});

t('Deposits: adding a row stores $date fields as real dates and generates a Row ID', () => {
  const sheets = makeLD();
  const deposits = byName(sheets, 'Deposits');
  const ctx = load(sheets);
  const res = post(ctx, { id: 'req-dep-1', tab: 'Deposits', values: { Customer: 'Morgan', 'Phone / Email': '555-0188', Device: 'MacBook Air', 'Total Price': 800, 'Deposit Paid': 150, 'Date Deposit Taken': { $date: '2026-10-30' }, 'Pickup By': { $date: '2026-11-15' }, Notes: 'deposit note' } });
  assert.equal(res.ok, true);
  assert.equal(res.row, 3);
  assert.deepEqual(res.unmatched, []);
  assert.ok(typeof res.rowId === 'string' && res.rowId.length > 0);
  const row = deposits.grid[2];
  assert.ok(isDate(row[0]));
  assert.equal(row[1], res.rowId);
  assert.equal(row[2], 'Morgan');
  assert.equal(row[5], 800);
  assert.equal(row[6], 150);
  assert.ok(isDate(row[7]) && isDate(row[8]));
  assert.deepEqual([row[7].getFullYear(), row[7].getMonth(), row[7].getDate()], [2026, 9, 30]);
  assert.deepEqual([row[8].getFullYear(), row[8].getMonth(), row[8].getDate()], [2026, 10, 15]);
});

t('Loans: a retry with the same request id adds nothing', () => {
  const sheets = makeLD();
  const loans = byName(sheets, 'Loans');
  const ctx = load(sheets);
  const body = { id: 'req-dup-1', tab: 'Loans', values: { Borrower: 'Casey', 'Amount Loaned': 120 } };
  const first = post(ctx, body);
  assert.equal(first.ok, true);
  assert.equal(first.dup, undefined);
  const len = loans.grid.length;
  const second = post(ctx, body);
  assert.equal(second.ok, true);
  assert.equal(second.dup, true);
  assert.equal(loans.grid.length, len);
});

t('Deposits: adding when the tab does not exist yet fails cleanly, creates no tab, changes nothing', () => {
  const sheets = makeLD({ noDeposits: true });
  const before = snapAll(sheets), count = sheets.length;
  const ctx = load(sheets);
  const res = post(ctx, { id: 'req-miss-1', tab: 'Deposits', values: { Customer: 'Riley', 'Total Price': 500 } });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'no tab: Deposits');
  assert.deepEqual(ctx.__created, []);
  assert.equal(sheets.length, count);
  unchanged(sheets, before);
});

t('Loans: an edit by Row ID with a matching expect writes the cells and logs old and new values in a new Edit Log', () => {
  const sheets = makeLD();
  const loans = byName(sheets, 'Loans');
  const ctx = load(sheets);
  const res = post(ctx, { action: 'edit', target: 'Loans', rowId: 'L1', expect: { Borrower: 'Sam', 'Amount Loaned': 200 }, changes: { Status: 'Returned', 'Amount Repaid': 200 } });
  assert.equal(res.ok, true);
  assert.deepEqual(res.updated.slice().sort(), ['Amount Repaid', 'Status']);
  assert.deepEqual(ctx.__created, ['Edit Log']);
  const log = byName(sheets, 'Edit Log');
  assert.ok(log);
  assert.deepEqual(log.grid[0], LOG_HEAD);
  assert.equal(log.grid.length, 3);
  const logRows = log.grid.slice(1);
  logRows.forEach(r => { assert.equal(r[1], 'Loans'); assert.equal(r[2], 'L1'); assert.equal(r[6], 'edit'); });
  const st = logRows.find(r => r[3] === 'Status'), rp = logRows.find(r => r[3] === 'Amount Repaid');
  assert.deepEqual([st[4], st[5]], ['', 'Returned']);
  assert.deepEqual([rp[4], rp[5]], [0, 200]);
  assert.equal(loans.grid[1][9], 'Returned');
  assert.equal(loans.grid[1][6], 200);
  assert.equal(loans.grid[2][9], '');   // the other loan is untouched
});

t('Loans: an edit whose expect no longer matches the live row is refused and nothing is written or logged', () => {
  const sheets = makeLD();
  const before = snapAll(sheets);
  const ctx = load(sheets);
  const res = post(ctx, { action: 'edit', target: 'Loans', rowId: 'L1', expect: { Borrower: 'Sam', 'Amount Loaned': 999 }, changes: { Status: 'Returned' } });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'row changed');
  assert.deepEqual(ctx.__created, []);
  sheets.forEach(s => assert.deepEqual(s.writes, []));
  unchanged(sheets, before);
});

t('Deposits: an edit with only one expect column is refused and nothing is written', () => {
  const sheets = makeLD();
  const before = snapAll(sheets);
  const ctx = load(sheets);
  const res = post(ctx, { action: 'edit', target: 'Deposits', rowId: 'D1', expect: { Customer: 'Jordan' }, changes: { Status: 'Picked Up' } });
  assert.equal(res.ok, false);
  assert.ok(String(res.error).includes('expect needs at least 2 columns'));
  assert.deepEqual(ctx.__created, []);
  sheets.forEach(s => assert.deepEqual(s.writes, []));
  unchanged(sheets, before);
});

t('Deposits: an edit by Row ID works and an unknown Row ID is refused', () => {
  const sheets = makeLD();
  const dep = byName(sheets, 'Deposits');
  const ctx = load(sheets);
  const bad = post(ctx, { action: 'edit', target: 'Deposits', rowId: 'nope', expect: { Customer: 'Jordan', 'Total Price': 900 }, changes: { Status: 'Picked Up' } });
  assert.equal(bad.ok, false);
  assert.equal(dep.grid[1][9], '');
  const ok = post(ctx, { action: 'edit', target: 'Deposits', rowId: 'D1', expect: { Customer: 'Jordan', 'Total Price': 900 }, changes: { Status: 'Picked Up', 'Date Closed': { $date: '2026-10-30' } } });
  assert.equal(ok.ok, true);
  assert.equal(dep.grid[1][9], 'Picked Up');
  assert.ok(isDate(dep.grid[1][10]));
});

t('Loans and Deposits: delete is refused (tab not allowed) and nothing changes', () => {
  const sheets = makeLD();
  const before = snapAll(sheets);
  const ctx = load(sheets);
  const l = post(ctx, { action: 'delete', target: 'Loans', rowId: 'L1', expect: { Borrower: 'Sam', 'Amount Loaned': 200 } });
  const d = post(ctx, { action: 'delete', target: 'Deposits', rowId: 'D1', expect: { Customer: 'Jordan', 'Total Price': 900 } });
  [l, d].forEach(r => { assert.equal(r.ok, false); assert.ok(String(r.error).includes('tab not allowed')); });
  sheets.forEach(s => assert.deepEqual(s.deleted, []));
  unchanged(sheets, before);
});

t('Loans and Deposits: reading returns their rows with row numbers; absent tabs come back as missing and are not created', () => {
  const ctx1 = load(makeLD());
  const r1 = get(ctx1, { action: 'read' });
  assert.equal(r1.ok, true);
  assert.deepEqual(r1.tabs.Loans.rows.map(r => [r['Row ID'], r._row]), [['L1', 2], ['L2', 3]]);
  assert.deepEqual(r1.tabs.Deposits.rows.map(r => [r['Row ID'], r._row]), [['D1', 2]]);
  assert.equal(r1.tabs.Loans.missing, undefined);

  const sheets2 = makeLD({ noLoans: true, noDeposits: true });
  const before = snapAll(sheets2), count = sheets2.length;
  const ctx2 = load(sheets2);
  const r2 = get(ctx2, { action: 'read' });
  const c2 = get(ctx2, { action: 'check' });
  assert.equal(r2.ok, true);
  assert.equal(c2.ok, true);
  ['Loans', 'Deposits'].forEach(k => { assert.equal(r2.tabs[k].missing, true); assert.deepEqual(r2.tabs[k].rows, []); });
  assert.deepEqual(ctx2.__created, []);
  assert.equal(sheets2.length, count);
  unchanged(sheets2, before);
});

t('Loans: the Row ID backfill fills only the one empty Row ID on a row that has data, and nothing else', () => {
  const sheets = makeLD();
  const loans = byName(sheets, 'Loans');
  loans.grid.push(['', '', 'Taylor', '555-0177', 'Mac mini', 400, 0, '2026-01-10', '2026-02-10', '', '', 'needs id']);
  const others = sheets.filter(s => s !== loans), beforeOthers = snapAll(others);
  const l1 = JSON.stringify(loans.grid[1]), l2 = JSON.stringify(loans.grid[2]);
  const target = loans.grid[3].slice();
  const ctx = load(sheets);
  const res = post(ctx, { action: 'backfill' });
  assert.equal(res.ok, true);
  assert.equal(res.total, 1);
  assert.equal(JSON.stringify(loans.grid[1]), l1);
  assert.equal(JSON.stringify(loans.grid[2]), l2);
  const row = loans.grid[3];
  assert.ok(typeof row[1] === 'string' && row[1].length > 0);
  row.forEach((v, c) => { if (c !== 1) assert.equal(v, target[c]); });
  others.forEach((s, i) => assert.equal(snap(s), beforeOthers[i]));
});

t('Loans and Deposits: tab lists allow add and edit only, never delete, and the formula-tab lists are unchanged', () => {
  const ctx = load(makeLD());
  const list = name => JSON.parse(vm.runInContext('JSON.stringify(' + name + ')', ctx));
  ['Loans', 'Deposits'].forEach(k => {
    assert.ok(list('ALLOWED_TABS').includes(k));
    assert.ok(list('EDIT_ONLY_TABS').includes(k));
    assert.ok(!list('EDITABLE_TABS').includes(k));
    assert.ok(!list('SALE_DELETE_TABS').includes(k));
    assert.ok(!list('TRADE_SOLD_TABS').includes(k));
    assert.ok(!list('TRADE_BOUGHT_TABS').includes(k));
  });
  assert.deepEqual(list('EDITABLE_TABS'), ['Expenses']);
});

console.log(`\n${n} checks passed`);
