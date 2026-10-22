// Run with: node tests/apps-script.test.mjs
// Loads apps-script.gs with a mocked Google Sheet and checks reads, appends and that nothing existing is touched.
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

function fixture() {
  const expenses = makeSheet('Expenses', [
    ['Timestamp', 'Item Purchased', 'Amount', 'Date of Purchase', 'Running Total'],
    ['', 'Coffee', 4.5, '2026-10-01', 4.5],
    ['', 'Lunch', 12, '2026-10-02', 16.5]
  ], { '2,5': '=C2', '3,5': '=E2+C3' }, 10);
  const summary = makeSheet('Summary', [['Total'], [100]], { '2,1': '=SUM(Expenses!C:C)' });
  return { expenses, summary, sheets: [expenses, summary] };
}

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ok -', name); };

test('doGet without action returns a status ping', () => {
  const { sheets } = fixture(); const ctx = load(sheets);
  const j = parse(ctx.doGet({ parameter: {} }));
  assert.equal(j.ok, true); assert.equal(j.status, 'success');
});

test('doGet?action=read returns every existing row and keeps the old shape', () => {
  const { sheets } = fixture(); const ctx = load(sheets);
  const j = parse(ctx.doGet({ parameter: { action: 'read' } }));
  assert.equal(j.ok, true); assert.equal(j.status, 'success');
  assert.equal(j.tabs.Expenses.rows.length, 2);
  assert.equal(j.tabs.Expenses.rows[0]['Item Purchased'], 'Coffee');
  assert.equal(j.tabs.Expenses.rows[1].Amount, 12);
  assert.equal(j.tabs.Phones.missing, true); // absent tabs are reported, not fatal
  assert.equal(j.data, undefined);           // flat view is opt-in
});

test('doGet?action=read&flat=1 adds data: [...] tagged by tab', () => {
  const { sheets } = fixture(); const ctx = load(sheets);
  const j = parse(ctx.doGet({ parameter: { action: 'read', flat: '1' } }));
  assert.equal(j.status, 'success'); assert.ok(Array.isArray(j.data)); assert.equal(j.data.length, 2);
  assert.equal(j.data[0]._tab, 'Expenses'); assert.equal(j.data[1]['Item Purchased'], 'Lunch');
});

test('reading never writes to the sheet', () => {
  const { expenses, sheets } = fixture(); const ctx = load(sheets);
  ctx.doGet({ parameter: { action: 'read' } }); ctx.doGet({ parameter: { action: 'check' } });
  assert.equal(expenses.writes.length, 0);
});

test('doPost appends below existing data and leaves formulas and other cells alone', () => {
  const { expenses, sheets } = fixture(); const ctx = load(sheets);
  const before = JSON.stringify(expenses.grid.slice(0, 3));
  const j = post(ctx, { id: 'a1', tab: 'Expenses', values: { 'Item Purchased': 'Snack', Amount: 3 } });
  assert.equal(j.ok, true); assert.equal(j.status, 'success'); assert.equal(j.row, 4);
  assert.equal(JSON.stringify(expenses.grid.slice(0, 3)), before);          // rows 1-3 untouched
  assert.deepEqual(expenses.writes.map(w => w[0]), [4, 4, 4]);              // only row 4 written (Timestamp, Item, Amount)
  assert.ok(!expenses.writes.some(w => w[1] === 5));                        // formula column never written
  assert.equal(expenses.formulas['2,5'], '=C2');
});

test('a new entry shows up on the next read (two-way)', () => {
  const { sheets } = fixture(); const ctx = load(sheets);
  post(ctx, { id: 'b1', tab: 'Expenses', values: { 'Item Purchased': 'Taxi', Amount: 20, 'Date of Purchase': '2026-10-03' } });
  const j = parse(ctx.doGet({ parameter: { action: 'read' } }));
  assert.equal(j.tabs.Expenses.rows.length, 3);
  assert.equal(j.tabs.Expenses.rows[2]['Item Purchased'], 'Taxi');
});

test('retrying the same id does not add a second row', () => {
  const { expenses, sheets } = fixture(); const ctx = load(sheets);
  post(ctx, { id: 'c1', tab: 'Expenses', values: { 'Item Purchased': 'Gum', Amount: 1 } });
  const n = expenses.writes.length;
  const j = post(ctx, { id: 'c1', tab: 'Expenses', values: { 'Item Purchased': 'Gum', Amount: 1 } });
  assert.equal(j.dup, true); assert.equal(expenses.writes.length, n);
});

test('tabs that are not on the allow-list (Summary) are refused and untouched', () => {
  const { summary, sheets } = fixture(); const ctx = load(sheets);
  const j = post(ctx, { id: 'd1', tab: 'Summary', values: { Total: 1 } });
  assert.equal(j.ok, false); assert.equal(j.status, 'error'); assert.equal(summary.writes.length, 0);
});

test('malformed or empty JSON is handled safely', () => {
  const { expenses, sheets } = fixture(); const ctx = load(sheets);
  assert.equal(post(ctx, '{not json').error, 'bad json');
  assert.equal(post(ctx, 'null').error, 'bad json');
  assert.equal(parse(ctx.doPost({})).ok, false);
  assert.equal(expenses.writes.length, 0);
});

test('never overwrites: refuses when the target cell already holds a value', () => {
  const { expenses, sheets } = fixture();
  expenses.grid.push(['', '', '', '', '']); // row 4 looks empty in the written columns...
  expenses.formulas['4,3'] = '=1+1';        // ...but Amount cell holds a formula
  const ctx = load(sheets);
  const before = JSON.stringify(expenses.grid);
  post(ctx, { id: 'e1', tab: 'Expenses', values: { Amount: 5 } });
  assert.ok(expenses.writes.every(w => !(w[0] === 4 && w[1] === 3)) || JSON.stringify(expenses.grid) === before);
  assert.equal(expenses.formulas['4,3'], '=1+1');
});

test('secret is enforced on read and write when set', () => {
  const { sheets } = fixture();
  const ctx = load(sheets); vm.runInContext("var SECRET_BAK = SECRET;", ctx);
  const guarded = load(sheets);
  const src = code.replace("const SECRET = '';", "const SECRET = 'pw';");
  const c2 = vm.createContext({ ...guarded }); vm.runInContext(src, c2);
  assert.equal(parse(c2.doGet({ parameter: { action: 'read' } })).error, 'auth');
  assert.equal(parse(c2.doGet({ parameter: { action: 'read', secret: 'pw' } })).ok, true);
  assert.equal(parse(c2.doPost({ postData: { contents: JSON.stringify({ tab: 'Expenses', values: {} }) } })).error, 'auth');
});

console.log(`\n${passed} tests passed`);
