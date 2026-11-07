// Run with: node --test tests/device-edit-sale.test.mjs
// Chunk 3e: the "Edit sale" plan, the old-to-new diff for the confirmation screen, the roll-back values used by Undo, and the Undo error texts.
// Loads the REAL helpers out of index.html (no copies) into a vm sandbox.
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
function between(a, b) { const s = html.indexOf(a); if (s < 0) throw new Error(a + ' not found'); const e = html.indexOf(b, s); if (e < 0) throw new Error(b + ' not found'); return html.slice(s, e); }

const ctx = vm.createContext({ console, $$: () => [], $: () => null, toast: () => {} });
const run = code => vm.runInContext(code, ctx);
run([
  constLine('clean'), constLine('numOf'), constLine('F'), constLine('C6'), constLine('YN'),
  between('const FORMS=[', '\nconst BY='), constLine('BY'),
  fnBlock('matchDeviceRows'),
  constLine('deL'), constLine('deNum'),
  'globalThis.window=globalThis; window.MMLog={BY,YN,numOf,sugList:()=>[]};',
  constLine('DE_FORM'), constLine('DE_TYPES'), constLine('DE_TABS'), constLine('deKey'),
  constLine('DE_SALE_TABS'), constLine('DE_SALE_FORM'),
  ...['deRowKey', 'dePlan', 'deStr', 'deInit', 'deFieldError', 'deSame', 'deCheck', 'deExpect', 'dePatch',
      'deSalePlan', 'deDiff', 'deRevertChanges', 'deUndoErrText'].map(fnBlock),
  "function rowErrText(e){return 'ROWERR:'+((e&&e.message)||'')}",
  'let V={};'
].join('\n'));

// Results come out of the vm with their own Object prototype, which strict deepEqual rejects, so copy them into this realm.
const plain = v => JSON.parse(JSON.stringify(v));

// Fixtures. Always a fresh copy so one test can never affect another.
function fixtures() {
  const bought = { 'Timestamp': '2026-10-01T10:00:00', 'Row ID': 'ab12', 'Serial Number': '356789012345678', 'Phone Model': 'iPhone 13' };
  const sold = { 'Timestamp': '2026-10-10T12:00:00', 'Row ID': 'sd56', 'Device Label': 'iPhone 13 - Blue', 'Sale Price': 600, 'Asking Price': 650, 'Sale Date': '2026-10-10', 'Clicks on Listing': 12, "Buyer's Name": 'Mia', 'Phone Number': null, 'Meetup Location/Address': 'Square One', 'Notes': null };
  const decoy = { ...sold, 'Row ID': 'sd99', 'Device Label': 'iPhone 12 - Red', 'Sale Price': 400, "Buyer's Name": 'Bob' };
  const raw = {
    BoughtPhones: { sheet: 'Form Responses - Bought', headers: Object.keys(bought), rows: [bought] },
    SoldPhones: { sheet: 'Form Responses - Sold', headers: Object.keys(sold), rows: [sold, decoy] }
  };
  const item = { kind: 'Phone', name: 'iPhone 13', sold: true, label: 'iPhone 13 - Blue', specs: { IMEI: '356789012345678' } };
  return { raw, item };
}

// Puts a fixture into the sandbox and builds the sale plan + its pre-filled values.
function loadSale(mutate) {
  const f = fixtures();
  if (mutate) mutate(f);
  ctx.raw = f.raw; ctx.item = f.item;
  run('V.plan=deSalePlan(item,raw); V.init=V.plan.state==="ok"?deInit(V.plan.form,V.plan.row):null;');
  return f;
}
const planOf = (raw, item) => { ctx.raw = raw; ctx.item = item; return plain(run('deSalePlan(item,raw)')); };
// deCheck on the SALE form: `over` replaces values, `touched` lists the fields the person touched.
const check = (over, touched) => { ctx.over = over; ctx.T = new Set(touched); return plain(run('deCheck(V.plan.form,Object.assign({},V.init.vals,over),V.init.orig,T)')); };

test('deSalePlan: a sold phone gives the Sold tab, its Row ID, and a form without the Device Label field', () => {
  const { raw, item } = fixtures();
  const p = planOf(raw, item);
  assert.equal(p.state, 'ok');
  assert.equal(p.tab, 'Form Responses - Sold');
  assert.equal(p.rowId, 'sd56');
  assert.equal(p.tabKey, 'SoldPhones');
  assert.equal(p.form.f.length, 8);
  assert.ok(!p.form.f.some(x => x.t === 'item' || x.k === 'Device Label'));
  // the shared form definition must never be changed
  const sphone = plain(run('BY.sphone'));
  assert.equal(sphone.f.length, 9);
  assert.ok(sphone.f.some(x => x.k === 'Device Label' && x.t === 'item'));
});

test('deSalePlan: nomatch for unsold, unmatched, ambiguous, wrong tab, wrong kind and missing items', () => {
  let { raw, item } = fixtures();
  assert.equal(planOf(raw, { ...item, sold: false }).state, 'nomatch');
  assert.equal(planOf(raw, { ...item, label: 'iPhone 13 - Nobody' }).state, 'nomatch');
  assert.equal(planOf(raw, { ...item, kind: 'Accessory' }).state, 'nomatch');
  assert.equal(planOf(raw, null).state, 'nomatch');
  assert.equal(planOf(raw, undefined).state, 'nomatch');
  ({ raw, item } = fixtures());
  raw.SoldPhones.rows.push({ ...raw.SoldPhones.rows[0], 'Row ID': 'sd57' });   // two rows with the same label
  assert.equal(planOf(raw, item).state, 'nomatch');
  ({ raw, item } = fixtures());
  raw.SoldPhones.sheet = 'Master Inventory';                                  // a formula tab is never a target
  assert.equal(planOf(raw, item).state, 'nomatch');
  ({ raw, item } = fixtures());
  raw.SoldPhones.sheet = 'PnA';
  assert.equal(planOf(raw, item).state, 'nomatch');
});

test('deSalePlan: noid when the matched sold row has no Row ID', () => {
  const { raw, item } = fixtures();
  raw.SoldPhones.rows[0]['Row ID'] = '';
  assert.equal(planOf(raw, item).state, 'noid');
});

test('deSalePlan: a sold PC uses SoldPCs and the Device column', () => {
  const raw = {
    BoughtPCs: { sheet: 'Form Responses - PCs', headers: ['Timestamp', 'Row ID', 'Serial Number'], rows: [{ 'Timestamp': 't', 'Row ID': 'pc12', 'Serial Number': 'SN12345' }] },
    SoldPCs: { sheet: 'Form Responses - Sold PCs', headers: ['Timestamp', 'Row ID', 'Device'], rows: [{ 'Timestamp': 't', 'Row ID': 'ps56', 'Device': 'ThinkPad X1 - Black', 'Sale Price': 800, 'Asking Price': 850, 'Sale Date': '2026-10-10', 'Clicks on Listing': 10, 'Sold to': 'Dan' }] }
  };
  const item = { kind: 'PC', name: 'ThinkPad X1', sold: true, label: 'ThinkPad X1 - Black', specs: { 'Serial Number': 'SN12345' } };
  const p = planOf(raw, item);
  assert.equal(p.state, 'ok');
  assert.equal(p.tab, 'Form Responses - Sold PCs');
  assert.equal(p.tabKey, 'SoldPCs');
  assert.equal(p.rowId, 'ps56');
  assert.ok(!p.form.f.some(x => x.t === 'item' || x.k === 'Device'));
});

test('changes builder (deCheck on the sale form): only touched AND different fields are sent, in the right shape', () => {
  loadSale();
  assert.deepEqual(check({ "Buyer's Name": 'Zoe' }, ["Buyer's Name"]).changes, { "Buyer's Name": 'Zoe' });
  assert.deepEqual(check({ 'Sale Price': '600.00' }, ['Sale Price']).changes, {}, 'same value is not a change');
  assert.deepEqual(check({ 'Sale Price': '650.5' }, ['Sale Price']).changes, { 'Sale Price': 650.5 });
  assert.deepEqual(check({ 'Sale Date': '2026-10-11' }, ['Sale Date']).changes, { 'Sale Date': { $date: '2026-10-11' } });
  assert.deepEqual(check({ 'Notes': '' }, ['Notes']).changes, {}, 'clearing an already-empty field is not a change');
  assert.deepEqual(check({ "Buyer's Name": '' }, ["Buyer's Name"]).changes, { "Buyer's Name": null });
  assert.deepEqual(check({ 'Notes': 'Edited but not touched' }, []).changes, {}, 'untouched fields are ignored');
  const bad = check({ 'Sale Price': 'abc' }, ['Sale Price']);
  assert.ok(bad.errors['Sale Price']);
  assert.equal(bad.count, 0);
  const two = check({ "Buyer's Name": 'Zoe', 'Sale Price': '610' }, ["Buyer's Name", 'Sale Price']);
  assert.equal(two.count, 2);
});

test('deExpect on the sale form: at least 2 unchanged, non-empty columns, never a changed one', () => {
  loadSale();
  ctx.keys = ['Sale Price'];
  const ex = plain(run('deExpect(V.plan.form,V.plan.row,keys)'));
  const row = plain(run('V.plan.row'));
  const keys = Object.keys(ex);
  assert.ok(keys.length >= 2);
  assert.ok(!keys.includes('Sale Price'));
  for (const k of keys) assert.equal(ex[k], row[k]);
});

test('deDiff: old to new in form order, blanks as (empty), money with 2 decimals', () => {
  loadSale();
  ctx.changes = { "Buyer's Name": 'Zoe', 'Sale Price': 650.5, 'Sale Date': { $date: '2026-10-11' } };
  const d = plain(run('deDiff(V.plan.form,V.init.orig,changes)'));
  assert.deepEqual(d.map(x => x.k), ['Sale Price', 'Sale Date', "Buyer's Name"]);
  assert.deepEqual([d[0].from, d[0].to], ['600.00', '650.50']);
  assert.deepEqual([d[1].from, d[1].to], ['2026-10-10', '2026-10-11']);
  assert.deepEqual([d[2].from, d[2].to], ['Mia', 'Zoe']);
  const fields = plain(run('V.plan.form.f'));
  for (const x of d) assert.equal(x.label, fields.find(f => f.k === x.k).l);
  ctx.cleared = { "Buyer's Name": null };
  assert.equal(plain(run('deDiff(V.plan.form,V.init.orig,cleared)'))[0].to, '(empty)');
  ctx.filled = { 'Notes': 'New note' };
  assert.equal(plain(run('deDiff(V.plan.form,V.init.orig,filled)'))[0].from, '(empty)');
  assert.deepEqual(plain(run('deDiff(V.plan.form,V.init.orig,{})')), []);
});

test('deRevertChanges: the original values in change shape, unknown keys ignored', () => {
  loadSale();
  ctx.keys = ['Sale Price', 'Sale Date', "Buyer's Name", 'Notes', 'No Such Column'];
  assert.deepEqual(plain(run('deRevertChanges(V.plan.form,V.init.orig,keys)')), {
    'Sale Price': 600, 'Sale Date': { $date: '2026-10-10' }, "Buyer's Name": 'Mia', 'Notes': null
  });
});

test('edit then Undo round trip on the local copy: the row returns to the original and nothing else moves', () => {
  const { raw } = loadSale();
  const before = plain(raw);
  ctx.changes = { 'Sale Price': 750, "Buyer's Name": 'Zoe', 'Sale Date': { $date: '2026-10-12' } };
  ctx.keys = Object.keys(ctx.changes);
  run('V.edited=dePatch(raw,V.plan.tabKey,V.plan.rowId,changes); V.back=dePatch(V.edited,V.plan.tabKey,V.plan.rowId,deRevertChanges(V.plan.form,V.init.orig,keys));');
  const edited = plain(run('V.edited'));
  assert.equal(edited.SoldPhones.rows[0]['Sale Price'], 750);
  assert.equal(edited.SoldPhones.rows[0]["Buyer's Name"], 'Zoe');
  assert.equal(edited.SoldPhones.rows[1]["Buyer's Name"], 'Bob', 'the other sold row is untouched');
  assert.deepEqual(edited.BoughtPhones, before.BoughtPhones, 'the purchase tab is untouched');
  assert.deepEqual(plain(run('V.back')), before);
  assert.deepEqual(plain(raw), before, 'the original object is never changed');
});

test('deUndoErrText: friendly text for each refusal, and the fallback', () => {
  const t = m => { ctx.err = m === null ? null : new Error(m); return run('deUndoErrText(err)'); };
  assert.equal(t('cell changed since the edit'), 'That cell changed since; nothing was changed.');
  assert.equal(t('nothing to undo'), 'Nothing left to undo.');
  assert.equal(t('cell has a formula'), 'That cell now holds a formula, so it was left alone. Nothing was changed.');
  assert.equal(t('tab not allowed: undefined'), 'Your entry script needs the newest version before it can undo. Nothing was changed.');
  assert.equal(t('oldscript'), 'Your entry script needs the newest version before it can undo. Nothing was changed.');
  assert.equal(t('log row changed'), 'Another change was made after this one, so nothing was undone.');
  assert.equal(t('something else'), 'ROWERR:something else');
  assert.equal(t(null), 'ROWERR:');
});

test('safety: neither tab list contains a formula tab', () => {
  const tabs = [...plain(run('DE_TABS')), ...plain(run('DE_SALE_TABS'))];
  assert.deepEqual(tabs, ['Form Responses - Bought', 'Form Responses - PCs', 'Bought Access - Form', 'Form Responses - Sold', 'Form Responses - Sold PCs']);
  for (const bad of ['Master Inventory', 'PnA', 'PCs', 'Summary']) assert.ok(!tabs.includes(bad));
});
