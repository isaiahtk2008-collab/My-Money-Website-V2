// Run with: node tests/edit-only-tabs.test.mjs
// Loads apps-script.gs with a mocked Google Sheet and proves: the six entry tabs can be EDITED (by Row ID, with old/new values written to the
// "Edit Log" tab BEFORE each cell is written) but never deleted; formula tabs and the Edit Log itself are refused for edit and delete; a failed
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

function makeFixtures() {
  const entryTabs = EDIT_ONLY.map((name, idx) => {
    const p = 'r' + idx;
    return makeSheet(name, [
      ['Timestamp', 'Row ID', 'Model', 'IMEI', 'Price'],
      ['', p + '1', 'iPhone 12', '111', 100],
      ['', p + '2', 'Pixel 7', '222', 200]
    ]);
  });
  const expenses = makeSheet('Expenses', [
    ['Timestamp', 'Row ID', 'Item Purchased', 'Amount', 'Date of Purchase', 'Establishment'],
    ['', 'e1', 'Tape', 10, '2025-01-01', 'Store'],
    ['', 'e2', 'Boxes', 20, '2025-01-02', 'OfficeDepot']
  ]);
  const masterInv = makeSheet('Master Inventory', [
    ['Timestamp', 'Row ID', 'Model', 'IMEI', 'Price'],
    ['', 'm1', 'iPhone 11', '333', 150]
  ]);
  const pcs = makeSheet('PCs', [
    ['Timestamp', 'Row ID', 'Model', 'Serial', 'Price'],
    ['', 'pc1', 'Dell XPS', '555', 400]
  ]);
  const pna = makeSheet('PnA', [
    ['Timestamp', 'Row ID', 'Item', 'Qty', 'Price'],
    ['', 'pn1', 'Cable', 10, 50]
  ]);
  const summary = makeSheet('Summary', [
    ['Metric', 'Value'],
    ['Total', 1000]
  ], { '2,1': '=SUM(A1)' });

  return [...entryTabs, expenses, masterInv, pcs, pna, summary];
}

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok -', name); };

t('edit by Row ID works on all six edit-only tabs and logs old/new in a new Edit Log tab', () => {
  const sheets = makeFixtures();
  const ctx = load(sheets);
  EDIT_ONLY.forEach((tabName, idx) => {
    const sheet = sheets.find(s => s.name === tabName);
    const res = post(ctx, { action: 'edit', target: tabName, rowId: `r${idx}1`, expect: { Model: 'iPhone 12', Price: 100 }, changes: { Price: 150 } });
    assert.equal(res.ok, true);
    assert.equal(res.status, 'success');
    assert.deepEqual(res.updated, ['Price']);
    assert.equal(sheet.grid[1][4], 150);
    assert.equal(sheet.grid[1][2], 'iPhone 12');
    assert.equal(sheet.grid[2][4], 200);
  });
  assert.deepEqual(ctx.__created, ['Edit Log']);
  const editLog = sheets.find(s => s.name === 'Edit Log');
  assert.ok(editLog);
  assert.deepEqual(editLog.grid[0], LOG_HEAD);
  assert.equal(editLog.grid.length, 7);
  EDIT_ONLY.forEach((tabName, idx) => {
    const row = editLog.grid[idx + 1];
    assert.ok(Object.prototype.toString.call(row[0]) === '[object Date]');
    assert.equal(row[1], tabName);
    assert.equal(row[2], `r${idx}1`);
    assert.equal(row[3], 'Price');
    assert.equal(row[4], 100);
    assert.equal(row[5], 150);
    assert.equal(row[6], 'edit');
  });
});

t('editing two columns logs each one BEFORE its cell is written', () => {
  const sheets = makeFixtures();
  const editLog = makeSheet('Edit Log', [LOG_HEAD.slice()]);
  sheets.push(editLog);
  const order = [];
  editLog.appendRow = row => {
    order.push(['log', row[3], row[5]]);
    editLog.appended.push(row);
    editLog.grid.push(row.slice());
  };
  const targetSheet = sheets.find(s => s.name === 'Form Responses - Bought');
  const origGetRange = targetSheet.getRange.bind(targetSheet);
  targetSheet.getRange = (r, c, nr = 1, nc = 1) => {
    const rng = origGetRange(r, c, nr, nc);
    const origSetValue = rng.setValue.bind(rng);
    rng.setValue = v => { order.push(['write', c, v]); origSetValue(v); };
    return rng;
  };
  const ctx = load(sheets);
  const res = post(ctx, { action: 'edit', target: 'Form Responses - Bought', rowId: 'r01', expect: { Model: 'iPhone 12', Price: 100 }, changes: { Model: 'iPhone 13', Price: 120 } });
  assert.equal(res.ok, true);
  assert.deepEqual(order, [
    ['log', 'Model', 'iPhone 13'],
    ['write', 3, 'iPhone 13'],
    ['log', 'Price', 120],
    ['write', 5, 120]
  ]);
});

t('a second edit reuses the existing Edit Log (no second tab, header not duplicated)', () => {
  const sheets = makeFixtures();
  const ctx = load(sheets);
  const res1 = post(ctx, { action: 'edit', target: 'Form Responses - Bought', rowId: 'r01', expect: { Model: 'iPhone 12', Price: 100 }, changes: { Price: 110 } });
  assert.equal(res1.ok, true);
  assert.deepEqual(ctx.__created, ['Edit Log']);
  const editLog = sheets.find(s => s.name === 'Edit Log');
  assert.equal(editLog.grid.length, 2);
  const res2 = post(ctx, { action: 'edit', target: 'Form Responses - PCs', rowId: 'r11', expect: { Model: 'iPhone 12', Price: 100 }, changes: { Price: 130 } });
  assert.equal(res2.ok, true);
  assert.deepEqual(ctx.__created, ['Edit Log']);
  assert.equal(editLog.grid.length, 3);
  assert.deepEqual(editLog.grid[0], LOG_HEAD);
  assert.equal(editLog.grid[1][5], 110);
  assert.equal(editLog.grid[2][5], 130);
});

t('delete on all six edit-only tabs is refused and nothing changes', () => {
  const sheets = makeFixtures();
  const ctx = load(sheets);
  EDIT_ONLY.forEach((tabName, idx) => {
    const sheet = sheets.find(s => s.name === tabName);
    const before = snap(sheet);
    const res = post(ctx, { action: 'delete', target: tabName, rowId: `r${idx}1`, expect: { Model: 'iPhone 12', Price: 100 } });
    assert.equal(res.ok, false);
    assert.equal(res.status, 'error');
    assert.equal(res.error, `tab not allowed: ${tabName}`);
    assert.equal(snap(sheet), before);
    assert.equal(sheet.deleted.length, 0);
  });
  assert.equal(sheets.some(s => s.name === 'Edit Log'), false);
  assert.equal(ctx.__created.length, 0);
});

t('formula tabs and the Edit Log itself are refused for edit AND delete', () => {
  const sheets = makeFixtures();
  const editLog = makeSheet('Edit Log', [LOG_HEAD.slice()]);
  sheets.push(editLog);
  const ctx = load(sheets);
  for (const tabName of ['Master Inventory', 'PCs', 'PnA', 'Summary', 'Edit Log']) {
    const sheet = sheets.find(s => s.name === tabName);
    const before = snap(sheet);
    const editRes = post(ctx, { action: 'edit', target: tabName, rowId: 'r1', expect: { a: 1, b: 2 }, changes: { a: 2 } });
    assert.equal(editRes.ok, false);
    assert.equal(editRes.error, `tab not allowed: ${tabName}`);
    assert.equal(snap(sheet), before);
    assert.equal(sheet.writes.length, 0);
    const delRes = post(ctx, { action: 'delete', target: tabName, rowId: 'r1', expect: { a: 1, b: 2 } });
    assert.equal(delRes.ok, false);
    assert.equal(delRes.error, `tab not allowed: ${tabName}`);
    assert.equal(snap(sheet), before);
    assert.equal(sheet.deleted.length, 0);
  }
  assert.equal(ctx.__created.length, 0);
});

t('a failed log write blocks the edit: the cell is not written', () => {
  const sheets = makeFixtures();
  const editLog = makeSheet('Edit Log', [LOG_HEAD.slice()]);
  editLog.failAppend = true;
  sheets.push(editLog);
  const ctx = load(sheets);
  const targetSheet = sheets.find(s => s.name === 'Form Responses - Bought');
  const res = post(ctx, { action: 'edit', target: 'Form Responses - Bought', rowId: 'r01', expect: { Model: 'iPhone 12', Price: 100 }, changes: { Price: 999 } });
  assert.equal(res.ok, false);
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'edit log write failed');
  assert.equal(targetSheet.grid[1][4], 100);
  assert.equal(targetSheet.writes.length, 0);
});

t('if the Edit Log tab cannot be created, the edit is blocked and nothing is written', () => {
  const sheets = makeFixtures();
  const ctx = load(sheets, { failInsert: true });
  const targetSheet = sheets.find(s => s.name === 'Form Responses - Bought');
  const res = post(ctx, { action: 'edit', target: 'Form Responses - Bought', rowId: 'r01', expect: { Model: 'iPhone 12', Price: 100 }, changes: { Price: 999 } });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'edit log unavailable');
  assert.equal(targetSheet.grid[1][4], 100);
  assert.equal(targetSheet.writes.length, 0);
});

t('Timestamp and formula cells are skipped: not written and not logged', () => {
  const sheets = makeFixtures();
  const bought = sheets.find(s => s.name === 'Form Responses - Bought');
  bought.formulas['2,4'] = '=CONCAT("1","11")';
  const ctx = load(sheets);
  const res = post(ctx, { action: 'edit', target: 'Form Responses - Bought', rowId: 'r01', expect: { Model: 'iPhone 12', Price: 100 }, changes: { Timestamp: '2025-09-09', IMEI: '999', Price: 300 } });
  assert.equal(res.ok, true);
  assert.deepEqual(res.updated, ['Price']);
  assert.ok(res.skipped.includes('Timestamp'));
  assert.ok(res.skipped.includes('IMEI'));
  assert.equal(bought.grid[1][0], '');
  assert.equal(bought.grid[1][3], '111');
  assert.equal(bought.grid[1][4], 300);
  const editLog = sheets.find(s => s.name === 'Edit Log');
  assert.equal(editLog.grid.length, 2);
  assert.equal(editLog.grid[1][3], 'Price');
  assert.equal(editLog.grid[1][5], 300);
});

t('a changed row or an unknown Row ID is refused and nothing is written or logged', () => {
  const sheets = makeFixtures();
  const ctx = load(sheets);
  const bought = sheets.find(s => s.name === 'Form Responses - Bought');
  const before = snap(bought);
  const notFound = post(ctx, { action: 'edit', target: 'Form Responses - Bought', rowId: 'missing-id', expect: { Model: 'iPhone 12', Price: 100 }, changes: { Price: 999 } });
  assert.equal(notFound.ok, false);
  assert.equal(notFound.error, 'row id not found');
  const mismatch = post(ctx, { action: 'edit', target: 'Form Responses - Bought', rowId: 'r01', expect: { Model: 'iPhone 12', Price: 999 }, changes: { Price: 500 } });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.error, 'row changed');
  assert.equal(snap(bought), before);
  assert.equal(bought.writes.length, 0);
  assert.equal(sheets.some(s => s.name === 'Edit Log'), false);
  assert.equal(ctx.__created.length, 0);
});

t('Expenses still edits (by Row ID and by row number) and deletes as before; a delete writes no log row', () => {
  const sheets = makeFixtures();
  const ctx = load(sheets);
  const expenses = sheets.find(s => s.name === 'Expenses');
  const res1 = post(ctx, { action: 'edit', target: 'Expenses', rowId: 'e1', expect: { 'Item Purchased': 'Tape', Amount: 10 }, changes: { Amount: 15 } });
  assert.equal(res1.ok, true);
  assert.deepEqual(res1.updated, ['Amount']);
  assert.equal(expenses.grid[1][3], 15);
  const editLog = sheets.find(s => s.name === 'Edit Log');
  assert.ok(editLog);
  assert.equal(editLog.grid.length, 2);
  assert.deepEqual(Array.from(editLog.grid[1]).slice(1), ['Expenses', 'e1', 'Amount', 10, 15, 'edit']); // Array.from: the row was built inside the vm context
  const res2 = post(ctx, { action: 'edit', target: 'Expenses', row: 2, expect: { 'Item Purchased': 'Tape', Amount: 15 }, changes: { Amount: 25 } });
  assert.equal(res2.ok, true);
  assert.equal(expenses.grid[1][3], 25);
  const logLen = editLog.grid.length;
  const res3 = post(ctx, { action: 'delete', target: 'Expenses', rowId: 'e1', expect: { 'Item Purchased': 'Tape', Amount: 25 } });
  assert.equal(res3.ok, true);
  assert.equal(res3.deleted, true);
  assert.deepEqual(expenses.deleted, [2]);
  assert.equal(expenses.grid.length, 2);
  assert.equal(expenses.grid[1][1], 'e2');
  assert.equal(editLog.grid.length, logLen);
});

t('reading (read and check) writes nothing, creates no tab, and returns the six new keys after the original five', () => {
  const sheets = makeFixtures();
  const ctx = load(sheets);
  const readRes = get(ctx, { action: 'read' });
  assert.equal(readRes.ok, true);
  const keys = Object.keys(readRes.tabs);
  assert.deepEqual(keys.slice(0, 5), ['Expenses', 'Phones', 'PCs', 'Accessories', 'Investments']);
  const six = ['BoughtPhones', 'BoughtPCs', 'BoughtAccess', 'SoldPhones', 'SoldPCs', 'SoldAccess'];
  assert.deepEqual(keys.slice(5), six);
  six.forEach((k, i) => {
    assert.equal(readRes.tabs[k].sheet, EDIT_ONLY[i]);
    assert.equal(readRes.tabs[k].rows.length, 2);
  });
  const checkRes = get(ctx, { action: 'check' });
  assert.equal(checkRes.ok, true);
  for (const s of sheets) {
    assert.equal(s.writes.length, 0);
    assert.equal(s.deleted.length, 0);
    assert.equal(s.appended.length, 0);
  }
  assert.equal(ctx.__created.length, 0);
  assert.equal(sheets.some(s => s.name === 'Edit Log'), false);
});

t('EDITABLE_TABS and EDIT_ONLY_TABS hold exactly the intended tabs and no formula tab', () => {
  const ctx = load(makeFixtures());
  const data = JSON.parse(vm.runInContext('JSON.stringify({e: EDITABLE_TABS, o: EDIT_ONLY_TABS})', ctx));
  assert.deepEqual(data.e, ['Expenses']);
  assert.deepEqual(data.o, EDIT_ONLY);
  for (const ft of ['Master Inventory', 'PCs', 'PnA', 'Summary', 'Edit Log']) {
    assert.ok(!data.e.includes(ft));
    assert.ok(!data.o.includes(ft));
  }
});

console.log(`\n${n} checks passed`);
