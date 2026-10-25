// Run with: node --test tests/device-edit.test.mjs
// Loads the REAL device-edit helpers out of index.html (no copies) and proves what they will and will not send to the sheet.
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.html'), 'utf8');
function constLine(name) { const m = html.match(new RegExp('^const ' + name + '=.*$', 'm')); if (!m) throw new Error(name + ' not found'); return m[0]; }
function fnBlock(name) {
  const start = html.indexOf('function ' + name + '(');
  if (start < 0) throw new Error(name + ' not found');
  let i = html.indexOf('{', html.indexOf(')', start)), d = 0;
  for (; i < html.length; i++) {
    if (html[i] === '{') d++;
    else if (html[i] === '}') { d--; if (d === 0) return html.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces in ' + name);
}
const asyncFn = name => 'async ' + fnBlock(name);
function between(a, b) { const s = html.indexOf(a); if (s < 0) throw new Error(a + ' not found'); const e = html.indexOf(b, s); if (e < 0) throw new Error(b + ' not found'); return html.slice(s, e); }

// Sandbox: stubs for the few browser things the real logging-form validate() touches.
const msgs = {};
const ctx = vm.createContext({ console, msgs, setErr: (k, m) => { msgs[k] = m; }, $$: () => [], $: () => null, toast: () => {} });
const run = code => vm.runInContext(code, ctx);
run([
  constLine('clean'), constLine('numOf'), constLine('F'), constLine('C6'), constLine('YN'),
  between('const FORMS=[', '\nconst BY='), constLine('BY'),
  fnBlock('matchDeviceRows'),
  constLine('deL'), constLine('deNum'),
  'globalThis.window=globalThis; window.MMLog={BY,YN,numOf,sugList:()=>[]};',
  constLine('DE_FORM'), constLine('DE_TYPES'), constLine('DE_TABS'), constLine('deKey'),
  ...['deRowKey', 'dePlan', 'deStr', 'deInit', 'deFieldError', 'deSame', 'deCheck', 'deExpect', 'dePatch', 'getVal', 'validate'].map(fnBlock),
  'let V={};'
].join('\n'));

// Fixtures. Always take a fresh copy (structuredClone) so one test can never affect another.
const row = (over = {}) => ({ 'Timestamp': '2026-10-01T10:00:00', 'Row ID': 'ab12', 'Serial Number': '356789012345678', 'Phone Model': 'iPhone 13', 'Color': 'Blue', 'Storage (GB)': 128, 'Condition': 'Used - Good', 'Screen Condition': 'Light scratches', 'Original Box': 'No', 'Charger': 'Yes', 'Case': 'No', 'Purchased Price': 450, 'Purchase Date': '2026-09-30', 'Bought From': 'Sam', 'Phone Number / Email Address': null, 'Meetup Location / Address': 'Square One', 'Notes': null, ...over });
const other = () => row({ 'Row ID': 'cd34', 'Serial Number': '999999999999999' });
const mkRaw = (rows = [row(), other()], sheet = 'Form Responses - Bought') => ({ BoughtPhones: { sheet, headers: Object.keys(row()), rows }, Expenses: { sheet: 'Expenses', headers: [], rows: [] } });
const phone = () => ({ kind: 'Phone', name: 'iPhone 13', sold: false, specs: { IMEI: '356789012345678' } });
const form = () => run('BY.bphone');
const field = k => form().f.find(x => x.k === k);
// Results come out of the vm with its own Object prototype, which strict deepEqual rejects, so copy them into this realm.
const plain = v => JSON.parse(JSON.stringify(v));
const check = (vals, orig, touched) => plain(ctx.deCheck(form(), vals, orig, new Set(touched)));

test('dePlan: returns ok for matching phone and raw data', () => {
  const res = ctx.dePlan(phone(), mkRaw());
  assert.equal(res.state, 'ok');
  assert.equal(res.tab, 'Form Responses - Bought');
  assert.equal(res.rowId, 'ab12');
  assert.equal(res.tabKey, 'BoughtPhones');
  assert.equal(res.form.id, 'bphone');
});

test('dePlan: returns nomatch or noid for invalid items, duplicate rows, disallowed tabs, and missing row IDs', () => {
  assert.equal(ctx.dePlan({ kind: 'Accessory', name: 'x', specs: {} }, mkRaw()).state, 'nomatch');
  assert.equal(ctx.dePlan(phone(), mkRaw([row(), row()])).state, 'nomatch');
  assert.equal(ctx.dePlan(phone(), mkRaw([row()], 'PnA')).state, 'nomatch');
  assert.equal(ctx.dePlan(null, mkRaw()).state, 'nomatch');
  assert.equal(ctx.dePlan(phone(), mkRaw([row({ 'Row ID': null })])).state, 'noid');
});

test('deInit: correctly initializes values and preserves orig values across types', () => {
  const { vals, orig } = ctx.deInit(form(), row());
  assert.equal(vals['Purchased Price'], '450.00');
  assert.equal(orig['Purchased Price'], '450');
  assert.equal(vals['Storage (GB)'], '128');
  assert.equal(vals['Original Box'], 'No');
  assert.equal(vals['Condition'], 'Used - Good');
  assert.equal(vals['Purchase Date'], '2026-09-30');

  const { vals: valsCaseInsensitive } = ctx.deInit(form(), row({ Condition: 'used - good' }));
  assert.equal(valsCaseInsensitive['Condition'], 'Used - Good');

  const { vals: valsUnknown, orig: origUnknown } = ctx.deInit(form(), row({ Condition: 'Mystery' }));
  assert.equal(valsUnknown['Condition'], '');
  assert.equal(origUnknown['Condition'], 'Mystery');

  const { vals: valsNullNotes } = ctx.deInit(form(), row({ Notes: null }));
  assert.equal(valsNullNotes['Notes'], '');
});

test('deCheck: handles empty touched and untouched fields correctly', () => {
  const { vals, orig } = ctx.deInit(form(), row());
  vals['Phone Model'] = '';
  const res = check(vals, orig, []);
  assert.equal(res.count, 0);
  assert.deepEqual(res.errors, {});
});

test('deCheck: handles valid changes, unchanged touched fields, and nullifying optional fields', () => {
  const { vals, orig } = ctx.deInit(form(), row());

  // Touching unchanged money field
  vals['Purchased Price'] = '450.00';
  let res = check(vals, orig, ['Purchased Price']);
  assert.equal(res.count, 0);

  // Changing money field
  vals['Purchased Price'] = '475';
  res = check(vals, orig, ['Purchased Price']);
  assert.deepEqual(res.changes, { 'Purchased Price': 475 });
  assert.equal(res.count, 1);

  // Changing date field
  vals['Purchase Date'] = '2026-10-02';
  res = check(vals, orig, ['Purchase Date']);
  assert.deepEqual(res.changes, { 'Purchase Date': { $date: '2026-10-02' } });

  // Clearing optional Notes field
  orig['Notes'] = 'x';
  vals['Notes'] = '';
  res = check(vals, orig, ['Notes']);
  assert.deepEqual(res.changes, { 'Notes': null });

  // Touching unchanged Color field
  vals['Color'] = 'Blue';
  res = check(vals, orig, ['Color']);
  assert.equal(res.count, 0);

  // Changing Color field
  vals['Color'] = 'Red';
  res = check(vals, orig, ['Color']);
  assert.deepEqual(res.changes, { 'Color': 'Red' });

  // Two touched changed fields at once without untouched fields leaking
  vals['Color'] = 'Red';
  vals['Purchased Price'] = '475';
  res = check(vals, orig, ['Color', 'Purchased Price']);
  assert.deepEqual(res.changes, { 'Color': 'Red', 'Purchased Price': 475 });
  assert.equal(res.count, 2);
});

test('deCheck: validates required fields, numbers, and dates', () => {
  const { vals, orig } = ctx.deInit(form(), row());

  // Required field cleared
  vals['Phone Model'] = '';
  let res = check(vals, orig, ['Phone Model']);
  assert.equal(res.count, 0);
  assert.deepEqual(res.errors, { 'Phone Model': 'Required' });

  // Negative price
  vals['Purchased Price'] = '-5';
  res = check(vals, orig, ['Purchased Price']);
  assert.equal(res.count, 0);
  assert.deepEqual(res.errors, { 'Purchased Price': "Can't be negative" });

  // Non-numeric price
  vals['Purchased Price'] = 'abc';
  res = check(vals, orig, ['Purchased Price']);
  assert.equal(res.count, 0);
  assert.deepEqual(res.errors, { 'Purchased Price': 'Enter a number' });

  // Non-integer storage
  vals['Storage (GB)'] = '12.5';
  res = check(vals, orig, ['Storage (GB)']);
  assert.equal(res.count, 0);
  assert.deepEqual(res.errors, { 'Storage (GB)': 'Whole number please' });

  // Malformed date
  vals['Purchase Date'] = '2026-1-1';
  res = check(vals, orig, ['Purchase Date']);
  assert.equal(res.count, 0);
  assert.deepEqual(res.errors, { 'Purchase Date': 'Pick a date' });
});

test('PARITY: deFieldError matches validate() across forms and sample values', () => {
  for (const formId of ['bphone', 'bpc']) {
    const fields = run('BY.' + formId).f;
    for (const s of ['', 'abc', '-5', '12.5', '12', '2026-1-1', '2026-10-02', 'Hello']) {
      const obj = {};
      for (const f of fields) {
        obj[f.k] = s;
      }
      run('V=' + JSON.stringify(obj));
      for (const k of Object.keys(msgs)) {
        delete msgs[k];
      }
      run('validate(BY.' + formId + ')');
      for (const x of fields) {
        const expected = msgs[x.k] || '';
        const actual = ctx.deFieldError(x, s);
        assert.equal(
          actual,
          expected,
          `Parity mismatch for form=${formId}, field=${x.k}, value=${JSON.stringify(s)}`
        );
      }
    }
  }
});

test('deExpect: returns 2-3 unchanged non-empty fields or null if <2', () => {
  const r = row();
  const f = form();

  // (a) changedKeys = ['Purchased Price'] -> 2 or 3 keys, none is 'Purchased Price', strictly equal to row()[k]
  const expA = plain(ctx.deExpect(f, r, ['Purchased Price']));
  assert.ok(expA && typeof expA === 'object');
  const keysA = Object.keys(expA);
  assert.ok(keysA.length >= 2 && keysA.length <= 3, `Expected 2 or 3 keys, got ${keysA.length}`);
  assert.ok(!keysA.includes('Purchased Price'), 'Should not include changed key Purchased Price');
  for (const k of keysA) {
    assert.strictEqual(expA[k], r[k], `Mismatch on key ${k}`);
  }

  // (b) when changedKeys is every field label of the form except 'Serial Number' -> null
  const allExceptSerial = f.f.map(x => x.k).filter(k => k !== 'Serial Number');
  assert.strictEqual(ctx.deExpect(f, r, allExceptSerial), null);

  // (c) row null -> null
  assert.strictEqual(ctx.deExpect(f, null, ['Purchased Price']), null);

  // (d) a row where every form field cell is null or '' except 'Serial Number' -> null
  const sparseRow = { ...r };
  for (const x of f.f) {
    if (x.k !== 'Serial Number') {
      sparseRow[x.k] = '';
    }
  }
  assert.strictEqual(ctx.deExpect(f, sparseRow, []), null);
});

test('dePatch: immutability, header-matching, and bailouts', () => {
  const r1 = row();
  const r2 = other();
  const raw = mkRaw([r1, r2]);
  const clone = structuredClone(raw);

  // (a) patch ab12 with updates
  const changes = {
    'Purchased Price': 475,
    'Notes': null,
    'Purchase Date': { $date: '2026-10-02' }
  };
  const patched = ctx.dePatch(raw, 'BoughtPhones', 'ab12', changes);

  assert.notStrictEqual(patched, raw);
  assert.notStrictEqual(patched.BoughtPhones.rows, raw.BoughtPhones.rows);
  assert.strictEqual(patched.Expenses, raw.Expenses);
  assert.deepEqual(raw, clone);

  const plainPatchedRows = plain(patched.BoughtPhones.rows);
  assert.strictEqual(plainPatchedRows[0]['Purchased Price'], 475);
  assert.strictEqual(plainPatchedRows[0]['Notes'], null);
  assert.strictEqual(plainPatchedRows[0]['Purchase Date'], '2026-10-02');
  assert.deepEqual(plainPatchedRows[1], plain(other()));

  // (b) unknown rowId 'zz' -> same reference
  const resB = ctx.dePatch(raw, 'BoughtPhones', 'zz', { Notes: 'test' });
  assert.strictEqual(resB, raw);

  // (c) two rows with Row ID 'ab12' -> same reference
  const duplicateRaw = mkRaw([row(), row()]);
  const resC = ctx.dePatch(duplicateRaw, 'BoughtPhones', 'ab12', { Notes: 'test' });
  assert.strictEqual(resC, duplicateRaw);

  // (d) tabKey 'BoughtPCs' (missing) -> same reference
  const resD = ctx.dePatch(raw, 'BoughtPCs', 'ab12', { Notes: 'test' });
  assert.strictEqual(resD, raw);

  // (e) change key 'purchased price' (lowercase) updates existing 'Purchased Price' and adds no new key
  const resE = ctx.dePatch(raw, 'BoughtPhones', 'ab12', { 'purchased price': 999 });
  const rowE = plain(resE.BoughtPhones.rows[0]);
  assert.strictEqual(rowE['Purchased Price'], 999);
  assert.strictEqual(Object.keys(rowE).length, Object.keys(r1).length);
});

test('SAFETY SCAN: the edit code can only target the two purchase tabs and never touches the log form hooks', () => {
  // Scan CODE only: the explanatory comments in that section name the forbidden things on purpose.
  const region = between(
    '/* ================= EDIT ONE PURCHASE ROW FROM A DEVICE',
    '/* ================= COMMAND PALETTE + HELP'
  ).replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(region.length > 1000, `Region length expected > 1000, got ${region.length}`);

  for (const forbidden of ['Master Inventory', "'PnA'", "'Summary'", "action:'delete'"]) {
    assert.ok(!region.includes(forbidden), `Region must not include ${forbidden}`);
  }

  assert.deepEqual(plain(run('DE_TABS')), ['Form Responses - Bought', 'Form Responses - PCs']);

  const occurrences = region.split('sheetCall(');
  assert.strictEqual(occurrences.length - 1, 1, 'Expected exactly 1 occurrence of sheetCall(');
  const snippet = region.slice(region.indexOf('sheetCall('), region.indexOf('sheetCall(') + 120);
  assert.ok(snippet.includes('target:plan.tab'), "Snippet must include 'target:plan.tab'");

  for (const hook of ['lg-in', 'data-ty', 'data-lg', 'data-k=', 'data-e=']) {
    assert.ok(!region.includes(hook), `Region must not include logging-form hook: ${hook}`);
  }
});
