// Run with: node tests/sale-row-delete.test.mjs
// Loads apps-script.gs with a mocked Google Sheet and proves: a row can be deleted from the three Sold tabs (by Row ID, with the full old row written
// to the "Edit Log" tab BEFORE it is removed) and nothing else changes; Bought tabs, trade sales, stale rows and rows with formulas are refused;
// a failed log write blocks the delete; a logged delete can never be "undone"; and Expenses deletes exactly as before (no log row).
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

const SOLD = ['Form Responses - Sold', 'Form Responses - Sold PCs', 'Sold Access - Form'];
const BOUGHT = ['Form Responses - Bought', 'Form Responses - PCs', 'Bought Access - Form'];
const LOG_HEAD = ['Timestamp', 'Tab', 'Row ID', 'Column', 'Old value', 'New value', 'Action'];

// Every Sold / Bought tab: 3 rows (ids a01..a03 / b01..b03 style). Row 4 of a Sold tab is a TRADE sale (Trade ID T-1).
function makeFixtures() {
  const entry = (tabs, letter) => tabs.map((name, i) => {
    const p = letter + i;
    return makeSheet(name, [
      ['Timestamp', 'Item', 'Sale Price', 'Row ID', 'Trade ID'],
      ['', 'iPhone 12', 100, p + '1', ''],
      ['', 'Pixel 7', 200, p + '2', ''],
      ['', 'Galaxy S9', 300, p + '3', 'T-1']
    ]);
  });
  const expenses = makeSheet('Expenses', [
    ['Timestamp', 'Row ID', 'Item Purchased', 'Amount'],
    ['', 'e1', 'Tape', 10],
    ['', 'e2', 'Boxes', 20]
  ]);
  const master = makeSheet('Master Inventory', [
    ['Timestamp', 'Row ID', 'Model', 'Price'],
    ['', 'm1', 'iPhone 11', 150]
  ]);
  return [...entry(SOLD, 'a'), ...entry(BOUGHT, 'b'), expenses, master];
}

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok -', name); };

t('a Sold-tab delete removes exactly that one row and changes nothing else', () => {
  SOLD.forEach((tabName, i) => {
    const sheets = makeFixtures();
    const ctx = load(sheets);
    const targetSheet = sheets.find(s => s.name === tabName);
    const originalGrid = targetSheet.grid.map(r => r.slice());
    const otherSheets = sheets.filter(s => s.name !== tabName);
    const otherSnaps = otherSheets.map(s => ({ name: s.name, snap: snap(s) }));

    const res = post(ctx, {
      action: 'delete',
      target: tabName,
      rowId: 'a' + i + '1',
      expect: { Item: 'iPhone 12', 'Sale Price': 100 }
    });

    assert.equal(res.ok, true);
    assert.equal(res.deleted, true);
    assert.equal(JSON.stringify(Array.from(targetSheet.deleted)), JSON.stringify([2]));

    const expectedGrid = [originalGrid[0], originalGrid[2], originalGrid[3]];
    assert.equal(JSON.stringify(targetSheet.grid), JSON.stringify(expectedGrid));

    for (const other of otherSheets) {
      const initial = otherSnaps.find(s => s.name === other.name);
      assert.equal(snap(other), initial.snap);
      assert.equal(JSON.stringify(Array.from(other.deleted)), JSON.stringify([]));
    }

    assert.equal(JSON.stringify(Array.from(ctx.__created)), JSON.stringify(['Edit Log']));
    const editLog = sheets.find(s => s.name === 'Edit Log');
    assert.ok(editLog);
    assert.equal(editLog.grid.length, 2);
  });
});

t('a Bought-tab delete is refused and nothing changes', () => {
  BOUGHT.forEach((tabName, i) => {
    const sheets = makeFixtures();
    const ctx = load(sheets);
    const targetSheet = sheets.find(s => s.name === tabName);
    const sBefore = snap(targetSheet);

    const res = post(ctx, {
      action: 'delete',
      target: tabName,
      rowId: 'b' + i + '1',
      expect: { Item: 'iPhone 12', 'Sale Price': 100 }
    });

    assert.equal(res.ok, false);
    assert.equal(res.error, `tab not allowed: ${tabName}`);
    assert.equal(snap(targetSheet), sBefore);
    assert.equal(JSON.stringify(Array.from(targetSheet.deleted)), JSON.stringify([]));
    assert.equal(JSON.stringify(Array.from(ctx.__created)), JSON.stringify([]));
  });
});

t('a trade sale is refused (Trade ID present) and nothing changes', () => {
  SOLD.forEach((tabName, i) => {
    const sheets = makeFixtures();
    const ctx = load(sheets);
    const targetSheet = sheets.find(s => s.name === tabName);
    const sBefore = snap(targetSheet);

    const res = post(ctx, {
      action: 'delete',
      target: tabName,
      rowId: 'a' + i + '3',
      expect: { Item: 'Galaxy S9', 'Sale Price': 300 }
    });

    assert.equal(res.ok, false);
    assert.equal(res.error, 'trade sale: edit it or fix it by hand');
    assert.equal(snap(targetSheet), sBefore);
    assert.equal(JSON.stringify(Array.from(targetSheet.deleted)), JSON.stringify([]));
    assert.equal(JSON.stringify(Array.from(ctx.__created)), JSON.stringify([]));
  });

  const noTradeSheet = makeSheet('Form Responses - Sold', [
    ['Timestamp', 'Item', 'Sale Price', 'Row ID'],
    ['', 'iPhone 12', 100, 'x1'],
    ['', 'Pixel 7', 200, 'x2']
  ]);
  const sBefore = snap(noTradeSheet);
  const ctx = load([noTradeSheet]);

  const res = post(ctx, {
    action: 'delete',
    target: 'Form Responses - Sold',
    rowId: 'x1',
    expect: { Item: 'iPhone 12', 'Sale Price': 100 }
  });

  assert.equal(res.ok, false);
  assert.equal(res.error, 'tab needs exactly one Trade ID column');
  assert.equal(snap(noTradeSheet), sBefore);
  assert.equal(JSON.stringify(Array.from(noTradeSheet.deleted)), JSON.stringify([]));
  assert.equal(JSON.stringify(Array.from(ctx.__created)), JSON.stringify([]));
});

t('a stale row is refused', () => {
  const sheets = makeFixtures();
  const ctx = load(sheets);
  const soldSheet = sheets.find(s => s.name === SOLD[0]);
  const sBefore = snap(soldSheet);

  const resChanged = post(ctx, {
    action: 'delete',
    target: SOLD[0],
    rowId: 'a01',
    expect: { Item: 'iPhone 12', 'Sale Price': 999 }
  });

  assert.equal(resChanged.ok, false);
  assert.equal(resChanged.error, 'row changed');
  assert.equal(snap(soldSheet), sBefore);
  assert.equal(JSON.stringify(Array.from(soldSheet.deleted)), JSON.stringify([]));
  assert.equal(JSON.stringify(Array.from(ctx.__created)), JSON.stringify([]));

  const resNotFound = post(ctx, {
    action: 'delete',
    target: SOLD[0],
    rowId: 'zz9',
    expect: { Item: 'iPhone 12', 'Sale Price': 100 }
  });

  assert.equal(resNotFound.ok, false);
  assert.equal(resNotFound.error, 'row id not found');
  assert.equal(snap(soldSheet), sBefore);
  assert.equal(JSON.stringify(Array.from(soldSheet.deleted)), JSON.stringify([]));
  assert.equal(JSON.stringify(Array.from(ctx.__created)), JSON.stringify([]));
});

t('a row with formulas is refused', () => {
  const sheets = makeFixtures();
  const soldSheet = sheets.find(s => s.name === SOLD[0]);
  soldSheet.formulas['2,3'] = '=A1+1';
  const sBefore = snap(soldSheet);
  const ctx = load(sheets);

  const res = post(ctx, {
    action: 'delete',
    target: SOLD[0],
    rowId: 'a01',
    expect: { Item: 'iPhone 12', 'Sale Price': 100 }
  });

  assert.equal(res.ok, false);
  assert.equal(res.error, 'row has formulas');
  assert.equal(snap(soldSheet), sBefore);
  assert.equal(JSON.stringify(Array.from(soldSheet.deleted)), JSON.stringify([]));
  assert.equal(JSON.stringify(Array.from(ctx.__created)), JSON.stringify([]));
});

t('the old row is written to the Edit Log BEFORE the row is deleted', () => {
  const sheets = makeFixtures();
  const editLog = makeSheet('Edit Log', [LOG_HEAD.slice()]);
  sheets.push(editLog);

  const soldSheet = sheets.find(s => s.name === SOLD[0]);
  const order = [];

  const origAppend = editLog.appendRow.bind(editLog);
  editLog.appendRow = (...args) => {
    order.push('log');
    return origAppend(...args);
  };

  const origDelete = soldSheet.deleteRow.bind(soldSheet);
  soldSheet.deleteRow = (...args) => {
    order.push('delete');
    return origDelete(...args);
  };

  const ctx = load(sheets);
  const res = post(ctx, {
    action: 'delete',
    target: SOLD[0],
    rowId: 'a02',
    expect: { Item: 'Pixel 7', 'Sale Price': 200 }
  });

  assert.equal(res.ok, true);
  assert.equal(JSON.stringify(order), JSON.stringify(['log', 'delete']));

  const logRow = editLog.grid[1];
  assert.equal(logRow[1], SOLD[0]);
  assert.equal(logRow[2], 'a02');
  assert.equal(logRow[3], 'ALL COLUMNS (row deleted)');
  assert.equal(logRow[5], '');
  assert.equal(logRow[6], 'delete');

  const expectedOldRow = {
    Timestamp: '',
    Item: 'Pixel 7',
    'Sale Price': 200,
    'Row ID': 'a02',
    'Trade ID': ''
  };
  assert.equal(JSON.stringify(JSON.parse(logRow[4])), JSON.stringify(expectedOldRow));

  // a logged delete is never undoable: undo ignores 'delete' log rows
  const snapAfterDelete = snap(soldSheet);
  const undoRes = post(ctx, { action: 'undo' });
  assert.equal(undoRes.ok, false);
  assert.equal(undoRes.error, 'nothing to undo');
  assert.equal(snap(soldSheet), snapAfterDelete);

  // if the log row cannot be written, the sale row is NOT deleted
  const sheets2 = makeFixtures();
  const editLog2 = makeSheet('Edit Log', [LOG_HEAD.slice()]);
  editLog2.failAppend = true;
  sheets2.push(editLog2);

  const soldSheet2 = sheets2.find(s => s.name === SOLD[0]);
  const snapBeforeFail = snap(soldSheet2);
  const ctx2 = load(sheets2);

  const resFail = post(ctx2, {
    action: 'delete',
    target: SOLD[0],
    rowId: 'a02',
    expect: { Item: 'Pixel 7', 'Sale Price': 200 }
  });

  assert.equal(resFail.ok, false);
  assert.equal(resFail.error, 'edit log write failed');
  assert.equal(snap(soldSheet2), snapBeforeFail);
  assert.equal(JSON.stringify(Array.from(soldSheet2.deleted)), JSON.stringify([]));
});

t('Expenses delete is unchanged: removes only that row and writes no log row', () => {
  const sheets = makeFixtures();
  const expenses = sheets.find(s => s.name === 'Expenses');
  const otherSheets = sheets.filter(s => s.name !== 'Expenses');
  const otherSnaps = otherSheets.map(s => ({ name: s.name, snap: snap(s) }));

  const ctx = load(sheets);
  const res = post(ctx, {
    action: 'delete',
    target: 'Expenses',
    rowId: 'e1',
    expect: { 'Item Purchased': 'Tape', Amount: 10 }
  });

  assert.equal(res.ok, true);
  assert.equal(res.deleted, true);
  assert.equal(JSON.stringify(Array.from(expenses.deleted)), JSON.stringify([2]));
  assert.equal(expenses.grid.length, 2);
  assert.equal(expenses.grid[1][1], 'e2');

  const logSheet = sheets.find(s => s.name === 'Edit Log');
  assert.equal(logSheet, undefined);
  assert.equal(JSON.stringify(Array.from(ctx.__created)), JSON.stringify([]));

  for (const other of otherSheets) {
    const initial = otherSnaps.find(s => s.name === other.name);
    assert.equal(snap(other), initial.snap);
    assert.equal(JSON.stringify(Array.from(other.deleted)), JSON.stringify([]));
  }
});

console.log(`\n${n} checks passed`);
