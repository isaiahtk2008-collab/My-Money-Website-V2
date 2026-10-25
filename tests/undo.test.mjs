// Run with: node tests/undo.test.mjs
// Loads apps-script.gs with a mocked Google Sheet and proves the POST action `undo`: it restores the exact old value of the latest Edit Log change,
// refuses when the cell changed since, never undoes the same edit twice, refuses protected tabs/formulas/Timestamp, and leaves add/edit/delete working.
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

t('1. undo restores exact old value', () => {
  const sheets = makeFixtures();
  const ctx = load(sheets);
  const target = sheets.find(s => s.name === 'Form Responses - Bought');
  const res1 = post(ctx, { action: 'edit', target: 'Form Responses - Bought', rowId: 'r01', expect: { Model: 'iPhone 12', Price: 100 }, changes: { Price: 150 } });
  assert.equal(res1.ok, true);
  const logSheet = sheets.find(s => s.name === 'Edit Log');
  const editRowBefore = JSON.stringify(logSheet.grid[1]);

  const snapTargetBefore = snap(target);
  const resUndo = post(ctx, { action: 'undo' });
  assert.equal(resUndo.ok, true);
  assert.equal(resUndo.undone, 'Price');
  assert.strictEqual(target.grid[1][4], 100);

  const parsedTargetBefore = JSON.parse(snapTargetBefore);
  parsedTargetBefore[1][4] = 100;
  assert.deepEqual(target.grid, parsedTargetBefore);

  assert.equal(logSheet.grid.length, 3);
  assert.equal(JSON.stringify(logSheet.grid[1]), editRowBefore);
  const undoLogRow = logSheet.grid[2];
  assert.equal(undoLogRow[2], 'r01');
  assert.equal(undoLogRow[3], 'Price');
  assert.strictEqual(undoLogRow[4], 150);
  assert.strictEqual(undoLogRow[5], 100);
  assert.equal(undoLogRow[6], 'undo');
});

t('2. undo restores text value and expenses edit', () => {
  const sheets = makeFixtures();
  const ctx = load(sheets);
  const bought = sheets.find(s => s.name === 'Form Responses - Bought');
  post(ctx, { action: 'edit', target: 'Form Responses - Bought', rowId: 'r01', expect: { Model: 'iPhone 12', Price: 100 }, changes: { Model: 'iPhone 13' } });
  assert.strictEqual(bought.grid[1][2], 'iPhone 13');
  const res1 = post(ctx, { action: 'undo' });
  assert.equal(res1.ok, true);
  assert.strictEqual(bought.grid[1][2], 'iPhone 12');

  const exp = sheets.find(s => s.name === 'Expenses');
  post(ctx, { action: 'edit', target: 'Expenses', rowId: 'e1', expect: { 'Item Purchased': 'Tape', Amount: 10 }, changes: { Amount: 99 } });
  assert.strictEqual(exp.grid[1][3], 99);
  const res2 = post(ctx, { action: 'undo' });
  assert.equal(res2.ok, true);
  assert.strictEqual(exp.grid[1][3], 10);
});

t('3. undo refuses when cell changed since', () => {
  const sheets = makeFixtures();
  const ctx = load(sheets);
  const target = sheets.find(s => s.name === 'Form Responses - Bought');
  post(ctx, { action: 'edit', target: 'Form Responses - Bought', rowId: 'r01', expect: { Model: 'iPhone 12', Price: 100 }, changes: { Price: 150 } });
  target.grid[1][4] = 175;
  const logSheet = sheets.find(s => s.name === 'Edit Log');
  const snapTarget = snap(target);
  const logLen = logSheet.grid.length;

  const res = post(ctx, { action: 'undo' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'cell changed since the edit');
  assert.equal(snap(target), snapTarget);
  assert.equal(logSheet.grid.length, logLen);
});

t('4. undo twice refuses; two edits are undone one at a time, newest first', () => {
  const sheets = makeFixtures();
  const ctx = load(sheets);
  const target = sheets.find(s => s.name === 'Form Responses - Bought');
  post(ctx, { action: 'edit', target: 'Form Responses - Bought', rowId: 'r01', expect: { Model: 'iPhone 12', Price: 100 }, changes: { Price: 150 } });
  const u1 = post(ctx, { action: 'undo' });
  assert.equal(u1.ok, true);

  const logSheet = sheets.find(s => s.name === 'Edit Log');
  const snapTarget = snap(target);
  const snapLog = snap(logSheet);
  const u2 = post(ctx, { action: 'undo' });
  assert.equal(u2.ok, false);
  assert.equal(u2.error, 'nothing to undo');
  assert.equal(snap(target), snapTarget);
  assert.equal(snap(logSheet), snapLog);

  post(ctx, { action: 'edit', target: 'Form Responses - Bought', rowId: 'r01', expect: { Model: 'iPhone 12', Price: 100 }, changes: { Price: 150 } });
  post(ctx, { action: 'edit', target: 'Form Responses - Bought', rowId: 'r01', expect: { Model: 'iPhone 12', Price: 150 }, changes: { Model: 'iPhone 13' } });
  assert.strictEqual(target.grid[1][2], 'iPhone 13');
  assert.strictEqual(target.grid[1][4], 150);

  const s1 = post(ctx, { action: 'undo' });
  assert.equal(s1.ok, true);
  assert.equal(s1.undone, 'Model');
  assert.strictEqual(target.grid[1][2], 'iPhone 12');
  assert.strictEqual(target.grid[1][4], 150);

  const s2 = post(ctx, { action: 'undo' });
  assert.equal(s2.ok, true);
  assert.equal(s2.undone, 'Price');
  assert.strictEqual(target.grid[1][4], 100);

  const s3 = post(ctx, { action: 'undo' });
  assert.equal(s3.ok, false);
  assert.equal(s3.error, 'nothing to undo');
});

t('5. undo with no Edit Log refuses and creates no tab', () => {
  const sheets = makeFixtures();
  const ctx = load(sheets);
  const res = post(ctx, { action: 'undo' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'nothing to undo');
  assert.equal(ctx.__created.length, 0);
});

t('6. undo on a protected tab is refused (Master Inventory, Edit Log itself, Summary)', () => {
  for (const tab of ['Master Inventory', 'Edit Log', 'Summary']) {
    const sheets = makeFixtures();
    sheets.push(makeSheet('Edit Log', [LOG_HEAD, [new Date(), tab, 'm1', 'Price', 150, 999, 'edit']]));
    const ctx = load(sheets);
    const before = sheets.map(snap);
    const res = post(ctx, { action: 'undo' });
    assert.equal(res.ok, false);
    assert.match(res.error, /^tab not allowed/);
    assert.deepEqual(sheets.map(snap), before);
  }
});

t('7. undo never touches a formula cell, Timestamp, or an unknown Row ID', () => {
  const sheets1 = makeFixtures();
  const ctx1 = load(sheets1);
  const target1 = sheets1.find(s => s.name === 'Form Responses - Bought');
  post(ctx1, { action: 'edit', target: 'Form Responses - Bought', rowId: 'r01', expect: { Model: 'iPhone 12', Price: 100 }, changes: { Price: 150 } });
  target1.formulas['2,5'] = '=1+1';
  const writesBefore = target1.writes.length;
  const res1 = post(ctx1, { action: 'undo' });
  assert.equal(res1.ok, false);
  assert.equal(res1.error, 'cell has a formula');
  assert.equal(target1.writes.length, writesBefore);
  assert.strictEqual(target1.grid[1][4], 150);

  const sheets2 = makeFixtures();
  sheets2.push(makeSheet('Edit Log', [LOG_HEAD, [new Date(), 'Form Responses - Bought', 'r01', 'Timestamp', 'old', 'new', 'edit']]));
  const res2 = post(load(sheets2), { action: 'undo' });
  assert.equal(res2.ok, false);
  assert.equal(res2.error, 'column not allowed');

  const sheets3 = makeFixtures();
  sheets3.push(makeSheet('Edit Log', [LOG_HEAD, [new Date(), 'Form Responses - Bought', 'nonexistent', 'Price', 100, 150, 'edit']]));
  const res3 = post(load(sheets3), { action: 'undo' });
  assert.equal(res3.ok, false);
  assert.equal(res3.error, 'row id not found');
});

t('8. a failed log write blocks the undo', () => {
  const sheets = makeFixtures();
  const ctx = load(sheets);
  const target = sheets.find(s => s.name === 'Form Responses - Bought');
  post(ctx, { action: 'edit', target: 'Form Responses - Bought', rowId: 'r01', expect: { Model: 'iPhone 12', Price: 100 }, changes: { Price: 150 } });
  sheets.find(s => s.name === 'Edit Log').failAppend = true;
  const res = post(ctx, { action: 'undo' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'edit log write failed');
  assert.strictEqual(target.grid[1][4], 150);
});

t('9. retry guard: a stale logRow changes nothing, the right one works', () => {
  const sheets = makeFixtures();
  const ctx = load(sheets);
  const target = sheets.find(s => s.name === 'Form Responses - Bought');
  post(ctx, { action: 'edit', target: 'Form Responses - Bought', rowId: 'r01', expect: { Model: 'iPhone 12', Price: 100 }, changes: { Price: 150 } });
  const resFail = post(ctx, { action: 'undo', logRow: 99 });
  assert.equal(resFail.ok, false);
  assert.equal(resFail.error, 'log row changed');
  assert.strictEqual(target.grid[1][4], 150);
  const resOk = post(ctx, { action: 'undo', logRow: 2 });
  assert.equal(resOk.ok, true);
  assert.strictEqual(target.grid[1][4], 100);
});

t('10. old add / edit / delete paths still pass', () => {
  const sheets = makeFixtures();
  const ctx = load(sheets);
  const exp = sheets.find(s => s.name === 'Expenses');
  const resAdd = post(ctx, { id: 'x1', tab: 'Expenses', values: { 'Item Purchased': 'Pens', Amount: 5 } });
  assert.equal(resAdd.ok, true);
  assert.equal(exp.grid.some(r => r[2] === 'Pens'), true);

  const resEdit = post(ctx, { action: 'edit', target: 'Expenses', rowId: 'e2', expect: { 'Item Purchased': 'Boxes', Amount: 20 }, changes: { Amount: 25 } });
  assert.equal(resEdit.ok, true);

  const resDel = post(ctx, { action: 'delete', target: 'Expenses', rowId: 'e2', expect: { 'Item Purchased': 'Boxes', Amount: 25 } });
  assert.equal(resDel.ok, true);
  assert.equal(resDel.deleted, true);

  const resDelEditOnly = post(ctx, { action: 'delete', target: 'Form Responses - Bought', rowId: 'r01', expect: { Model: 'iPhone 12', Price: 100 } });
  assert.equal(resDelEditOnly.ok, false);
});

console.log(`\n${n} checks passed`);
