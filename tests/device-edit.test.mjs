// Run with: node --test tests/device-edit.test.mjs
// Loads the REAL device Edit code (deviceEditInfo, deviceFootHtml, openDeviceEdit, saveDeviceEdit, patchDeviceTab) and the REAL
// logging-form FORMS out of index.html (no copies) into a sandbox with stubs, and proves:
//  - Edit/Delete only appear when matchDeviceRows says ok AND the Bought tab has this row's Row ID; otherwise a plain message and no buttons
//  - Delete is shown but disabled with the "do it in Google Sheets" note; Edit sits after it (Delete left, Edit right)
//  - the popup is built from the matching purchase form (labels, types) with one "Edit purchase" tab, pre-filled from the matched row
//  - save validates like the logging form, sends ONLY changed fields by rowId with 2+ unchanged expect columns, and patches only that one tab
//  - the target is only ever one of the two Bought tabs, never PnA / Master Inventory / PCs / Summary
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
const J = x => JSON.parse(JSON.stringify(x));   // objects made inside the vm have another prototype; compare plain JSON instead

const formsStart = html.indexOf('const FORMS=[');
const formsEnd = html.indexOf('\nconst BY=');
if (formsStart < 0 || formsEnd < formsStart) throw new Error('FORMS block not found');

const code = [
  constLine('dvNorm'), constLine('dvCell'), constLine('dvDay'), constLine('isoDay'),
  constLine('clean'), constLine('numOf'), constLine('YN'), constLine('C6'), constLine('F'),
  html.slice(formsStart, formsEnd),
  fnBlock('matchDeviceRows'), fnBlock('deviceEditInfo'), fnBlock('deviceFootHtml'),
  fnBlock('openDeviceEdit'), fnBlock('patchDeviceTab'), asyncFn('saveDeviceEdit'),
  'window.__mmLog={FORMS,YN,numOf};'
].join('\n');

const UNSAFE = ['PnA', 'Master Inventory', 'PCs', 'Summary'];

function setup() {
  const calls = [], toasts = [], errs = [];
  const sb = {
    window: {}, calls, toasts, errs, lastHtml: '', rowBusy: false, sheetFail: null, inputs: {}, errEls: {},
    esc: s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    ICON: { x: 'x' },
    toast: m => toasts.push(m),
    closeOverlay() {},
    openOverlay(h) { sb.lastHtml = h; },
    syncSoon() {},
    rowShowErr: e => errs.push(e),
    rowSetBusy(on) { sb.rowBusy = !!on; },
    sheetCall: async p => { calls.push(p); if (sb.sheetFail) throw sb.sheetFail; return { ok: true }; },
    store: { base: null, raw: null, D: { byId: new Map() }, set(raw) { this.base = raw; this.raw = raw; } },
    $: (sel, root) => sel.startsWith('#dv-') ? sb.inputs[sel.slice(1)] : (sel === '.ed-err' && root ? root.errBox : null),
    $$: () => Object.values(sb.errEls)
  };
  const ctx = vm.createContext(sb);
  vm.runInContext(code, ctx);
  const FORMS = sb.window.__mmLog.FORMS;
  const form = id => FORMS.find(f => f.id === id);

  const phone1 = { 'Timestamp': '2026-09-01T10:00:00', 'Serial Number': '356789012345678', 'Phone Model': 'iPhone 13', 'Color': 'Blue', 'Storage (GB)': 128,
    'Condition': 'Used - Good', 'Screen Condition': 'Pristine', 'Original Box': 'Yes', 'Charger': 'No', 'Case': 'No', 'Purchased Price': 300,
    'Purchase Date': '2026-09-01', 'Bought From': 'Sam', 'Phone Number / Email Address': null, 'Meetup Location / Address': 'Square One', 'Notes': null, 'Row ID': 'R-1' };
  const phone2 = Object.assign({}, phone1, { 'Timestamp': '2026-09-02T11:00:00', 'Serial Number': '987654321098765', 'Phone Model': 'iPhone 12', 'Notes': 'Minor scratch', 'Row ID': 'R-2' });
  const pc1 = {}; form('bpc').f.forEach(f => { pc1[f.k] = f.t === 'money' || f.t === 'int' ? 500 : f.t === 'date' ? '2026-09-01' : 'Sample'; });
  Object.assign(pc1, { 'Timestamp': '2026-09-01T10:00:00', 'Serial Number': 'PCSERIAL1', 'PC model': 'ThinkPad T14', 'Row ID': 'P-1' });
  const hdr = (f, extra) => ['Timestamp', ...f.f.map(x => x.k), 'Row ID', ...(extra || [])];
  const raw = {
    BoughtPhones: { sheet: 'Form Responses - Bought', headers: hdr(form('bphone')), rows: [phone1, phone2] },
    BoughtPCs: { sheet: 'Form Responses - PCs', headers: hdr(form('bpc')), rows: [pc1] },
    SoldPhones: { sheet: 'Form Responses - Sold', headers: ['Device Label'], rows: [] },
    SoldPCs: { sheet: 'Form Responses - Sold PCs', headers: ['Device'], rows: [] },
    Expenses: { sheet: 'Expenses', headers: ['Item Purchased', 'Amount', 'Date of Purchase'], rows: [{ 'Item Purchased': 'Cable', 'Amount': 10, 'Date of Purchase': '2026-09-01' }] }
  };
  sb.store.set(raw);
  const items = {
    item1: { id: 'item1', name: 'iPhone 13', kind: 'Phone', serial: '356789012345678', sold: false },
    pc1: { id: 'pc1', name: 'ThinkPad T14', kind: 'PC', serial: 'PCSERIAL1', sold: false },
    acc1: { id: 'acc1', name: 'Case', kind: 'Accessory', serial: '', sold: false }
  };
  Object.keys(items).forEach(k => sb.store.D.byId.set(k, { type: 'item', o: items[k] }));

  // Starts the popup "as opened": every input holds the matched row's current value, so a test only overrides what it changes.
  function fill(formId, row) {
    sb.inputs = {}; sb.errEls = {};
    form(formId).f.forEach((f, i) => {
      let v = row[f.k]; v = v == null ? '' : String(v); if (f.t === 'date') v = v.slice(0, 10);
      sb.inputs['dv-' + i] = { value: v };
      sb.errEls[f.k] = { dataset: { ed: f.k }, classList: { toggle() {} }, errBox: { textContent: '', hidden: true } };
    });
  }
  function set(formId, label, value) {
    const i = form(formId).f.findIndex(f => f.k === label);
    if (i < 0) throw new Error('no field ' + label);
    sb.inputs['dv-' + i].value = value;
  }
  const info = id => ctx.deviceEditInfo(sb.store.D.byId.get(id).o);
  const foot = id => ctx.deviceFootHtml(sb.store.D.byId.get(id).o);
  return { ctx, sb, raw, items, fill, set, info, foot, form, calls, toasts, errs };
}

test('deviceEditInfo is ok for a matched phone and a matched PC (Bought tabs, by Row ID)', () => {
  const { info } = setup();
  const p = info('item1');
  assert.equal(p.state, 'ok'); assert.equal(p.tabName, 'Form Responses - Bought'); assert.equal(p.tabKey, 'BoughtPhones'); assert.equal(p.formId, 'bphone'); assert.equal(p.rowId, 'R-1');
  const c = info('pc1');
  assert.equal(c.state, 'ok'); assert.equal(c.tabName, 'Form Responses - PCs'); assert.equal(c.tabKey, 'BoughtPCs'); assert.equal(c.formId, 'bpc'); assert.equal(c.rowId, 'P-1');
});

test('deviceEditInfo refuses anything doubtful', () => {
  { const t = setup(); t.raw.BoughtPhones.rows[0]['Row ID'] = ''; assert.equal(t.info('item1').state, 'blocked'); }
  { const t = setup(); t.raw.BoughtPhones.headers = t.raw.BoughtPhones.headers.filter(h => h !== 'Row ID'); assert.equal(t.info('item1').state, 'nomatch'); }
  { const t = setup(); assert.equal(t.info('acc1').state, 'nomatch'); }
  { const t = setup(); const dup = Object.assign({}, t.raw.BoughtPhones.rows[0], { 'Row ID': 'R-3' }); t.raw.BoughtPhones.rows.push(dup); assert.equal(t.info('item1').state, 'nomatch'); }
  for (const name of UNSAFE) { const t = setup(); t.raw.BoughtPhones.sheet = name; assert.equal(t.info('item1').state, 'nomatch', name); }
  { const t = setup(); t.sb.store.base = null; t.sb.store.raw = null; assert.doesNotThrow(() => assert.equal(t.info('item1').state, 'nomatch')); }
});

test('deviceFootHtml: disabled Delete on the left, Edit on the right, with the note; or a plain message with no buttons', () => {
  { const { foot } = setup(); const h = foot('item1');
    assert.match(h, /<button[^>]*class="btn danger"[^>]*disabled[^>]*>Delete<\/button>/);
    assert.match(h, /data-act="devedit" data-id="item1">Edit<\/button>/);
    assert.ok(h.includes('Delete purchases and sales directly in Google Sheets for now'));
    assert.ok(h.indexOf('>Delete<') < h.indexOf('>Edit<'));
    assert.equal((h.match(/<button/g) || []).length, 2); }
  { const { foot } = setup(); const h = foot('acc1');
    assert.ok(h.includes("Can't safely match this item to its sheet row")); assert.ok(!h.includes('devedit')); assert.ok(!h.includes('<button')); }
  { const t = setup(); t.raw.BoughtPhones.rows[0]['Row ID'] = ''; const h = t.foot('item1');
    assert.ok(h.includes('Run the ID backfill first')); assert.ok(!h.includes('<button')); }
});

test('openDeviceEdit builds the popup from the purchase form, one tab, pre-filled', () => {
  const { ctx, sb, form } = setup();
  ctx.openDeviceEdit('item1');
  const h = sb.lastHtml;
  assert.ok(h.includes('Edit purchase')); assert.ok(h.includes('role="tablist"')); assert.ok(h.includes('data-devform="item1"'));
  assert.equal((h.match(/role="tab"/g) || []).length, 1);
  for (const f of form('bphone').f) assert.ok(h.includes('data-ed="' + sb.esc(f.k) + '"'), 'missing field ' + f.k);
  assert.ok(h.includes('value="356789012345678"'));
  assert.ok(h.includes('value="2026-09-01"'));
  ctx.openDeviceEdit('acc1'); // not matchable: nothing new is opened
  assert.equal(sb.lastHtml, h);
});

test('save sends only the changed fields by rowId with 2+ unchanged expect columns, and patches only the Bought tab', async () => {
  const { ctx, sb, raw, fill, set, calls, toasts } = setup();
  fill('bphone', raw.BoughtPhones.rows[0]);
  set('bphone', 'Purchased Price', '325.50'); set('bphone', 'Purchase Date', '2026-10-01');
  const before = { e: sb.store.base.Expenses, pcs: sb.store.base.BoughtPCs, sp: sb.store.base.SoldPhones, spc: sb.store.base.SoldPCs };
  const r2 = J(sb.store.base.BoughtPhones.rows[1]);
  await ctx.saveDeviceEdit('item1');
  assert.equal(calls.length, 1);
  const p = calls[0];
  assert.equal(p.action, 'edit'); assert.equal(p.target, 'Form Responses - Bought'); assert.equal(p.rowId, 'R-1'); assert.ok(!('row' in p));
  assert.deepEqual(J(p.changes), { 'Purchased Price': 325.5, 'Purchase Date': { $date: '2026-10-01' } });
  assert.ok(Object.keys(p.expect).length >= 2); assert.ok('Serial Number' in p.expect);
  for (const k of Object.keys(p.changes)) assert.ok(!(k in p.expect), k + ' is changed so it must not be in expect');
  assert.equal(sb.store.base.BoughtPhones.rows[0]['Purchased Price'], 325.5);
  assert.equal(sb.store.base.BoughtPhones.rows[0]['Purchase Date'], '2026-10-01');
  assert.deepEqual(J(sb.store.base.BoughtPhones.rows[1]), r2);
  assert.strictEqual(sb.store.base.Expenses, before.e); assert.strictEqual(sb.store.base.BoughtPCs, before.pcs);
  assert.strictEqual(sb.store.base.SoldPhones, before.sp); assert.strictEqual(sb.store.base.SoldPCs, before.spc);
  assert.ok(toasts.includes('Saved to your sheet')); assert.equal(sb.rowBusy, false);
});

test('saving with no changes sends nothing', async () => {
  const { ctx, raw, fill, calls, toasts } = setup();
  fill('bphone', raw.BoughtPhones.rows[0]);
  await ctx.saveDeviceEdit('item1');
  assert.equal(calls.length, 0); assert.ok(toasts.includes('No changes to save'));
});

test('validation matches the logging form and clears once fixed', async () => {
  const bad = [['Phone Model', ''], ['Purchased Price', 'abc'], ['Purchased Price', '-5'], ['Storage (GB)', '12.5'], ['Purchase Date', 'not a date']];
  for (const [label, val] of bad) {
    const { ctx, sb, raw, fill, set, calls, errs } = setup();
    fill('bphone', raw.BoughtPhones.rows[0]); set('bphone', label, val);
    await ctx.saveDeviceEdit('item1');
    assert.equal(calls.length, 0, label + '=' + val); assert.equal(errs.length, 0);
    assert.ok(sb.errEls[label].errBox.textContent.length > 0, label + ' should show a message');
  }
  const { ctx, sb, raw, fill, set, calls } = setup();
  fill('bphone', raw.BoughtPhones.rows[0]); set('bphone', 'Purchased Price', 'abc');
  await ctx.saveDeviceEdit('item1');
  assert.ok(sb.errEls['Purchased Price'].errBox.textContent.length > 0);
  set('bphone', 'Purchased Price', '350');
  await ctx.saveDeviceEdit('item1');
  assert.equal(calls.length, 1); assert.equal(sb.errEls['Purchased Price'].errBox.textContent, ''); assert.equal(sb.errEls['Purchased Price'].errBox.hidden, true);
});

test('clearing an optional field sends null', async () => {
  const { ctx, raw, fill, set, calls } = setup();
  raw.BoughtPhones.rows[0]['Notes'] = 'scratch';
  fill('bphone', raw.BoughtPhones.rows[0]); set('bphone', 'Notes', '');
  await ctx.saveDeviceEdit('item1');
  assert.equal(calls.length, 1); assert.deepEqual(J(calls[0].changes), { Notes: null });
});

test('when the sheet refuses, the error is shown and local data is untouched', async () => {
  const { ctx, sb, raw, fill, set, errs } = setup();
  fill('bphone', raw.BoughtPhones.rows[0]); set('bphone', 'Purchased Price', '350');
  const baseBefore = sb.store.base, e = new Error('row changed'); sb.sheetFail = e;
  await ctx.saveDeviceEdit('item1');
  assert.equal(errs.length, 1); assert.strictEqual(errs[0], e);
  assert.strictEqual(sb.store.base, baseBefore); assert.equal(sb.store.base.BoughtPhones.rows[0]['Purchased Price'], 300); assert.equal(sb.rowBusy, false);
});

test('a save already in progress blocks a second one', async () => {
  const { ctx, sb, raw, fill, set, calls } = setup();
  fill('bphone', raw.BoughtPhones.rows[0]); set('bphone', 'Purchased Price', '350');
  sb.rowBusy = true;
  await ctx.saveDeviceEdit('item1');
  assert.equal(calls.length, 0);
});

test('the target is only ever a Bought tab, never a formula tab', async () => {
  const sent = [];
  { const t = setup(); t.fill('bphone', t.raw.BoughtPhones.rows[0]); t.set('bphone', 'Purchased Price', '325.50'); await t.ctx.saveDeviceEdit('item1'); sent.push(...t.calls.map(c => c.target)); }
  { const t = setup(); t.fill('bpc', t.raw.BoughtPCs.rows[0]); t.set('bpc', 'Purchase Price', '600'); await t.ctx.saveDeviceEdit('pc1'); sent.push(...t.calls.map(c => c.target)); }
  assert.deepEqual(sent, ['Form Responses - Bought', 'Form Responses - PCs']);
  for (const s of sent) assert.ok(!UNSAFE.includes(s));
});
