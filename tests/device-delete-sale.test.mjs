// Run with: node --test tests/device-delete-sale.test.mjs
// Device drawer "Delete sale": enabled ONLY for a sold device whose sale row matched safely and is not a trade sale.
// It removes ONLY the sale row (Sold tab), never the purchase row, and the device returns to inventory in the computed data.
// Loads the REAL functions out of index.html (no copies) into a vm sandbox.
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, '..', 'index.html'), 'utf8');
function constLine(n) { const m = html.match(new RegExp('^const ' + n + '=', 'm')); if (!m) throw new Error('const ' + n + ' missing'); const lines = html.slice(m.index).split('\n'); let code = ''; for (const l of lines) { code += (code ? '\n' : '') + l; try { new Function(code); return code; } catch (e) {} } throw new Error('const ' + n + ' unparsable'); }
function fnBlock(name) { const s = html.indexOf('function ' + name + '('); if (s < 0) throw new Error('fn ' + name + ' missing'); let i = html.indexOf('{', html.indexOf(')', s)), d = 0; for (; i < html.length; i++) { if (html[i] === '{') d++; else if (html[i] === '}') { d--; if (!d) return html.slice(s, i + 1); } } throw new Error('unbalanced ' + name); }
function between(a, b) { const s = html.indexOf(a); if (s < 0) throw new Error(a + ' not found'); const e = html.indexOf(b, s); if (e < 0) throw new Error(b + ' not found'); return html.slice(s, e); }

const consts = ['esc', 'nf0', 'nf2', 'mny', 'M', 'sgn', 'SM', 'pct', 'sum', 'avg', 'median', 'groupBy', 'plural', 'num', 'MO', 'DOW', 'DAY', 'sod', 'TODAY', 'addD', 'diffD', 'fd', 'fdy', 'dkey', 'pd', 'inR', 'clean', 'numOf', 'CAT_MAP', 'TYPE_MAP', 'F', 'C6', 'YN'].map(constLine);
const funcs = ['canonCondition', 'canonRam', 'normalize', 'inventoryStats', 'tradeFields', 'matchDeviceRows', 'deRowKey', 'dePlan', 'deSalePlan', 'deExpect',
  'dsPlan', 'dsRequest', 'dsPatch', 'dsErrText', 'deviceFootHtml', 'openDeviceSaleDelete'].map(fnBlock);
funcs.push('async ' + fnBlock('deleteDeviceSaleGo'));   // fnBlock starts at the word function, so async is added back
const ctx = vm.createContext({ Intl, Math, Date, Set, Map, Array, Object, JSON, Number, String, RegExp, console, Promise, Error });
const run = code => vm.runInContext(code, ctx);
run([
  ...consts,
  between('const FORMS=[', '\nconst BY='), constLine('BY'),
  constLine('deL'), constLine('deNum'),
  'globalThis.window=globalThis; window.MMLog={BY,YN,numOf,sugList:()=>[]};',
  constLine('DE_FORM'), constLine('DE_TYPES'), constLine('DE_TABS'), constLine('deKey'), constLine('DE_SALE_TABS'), constLine('DE_SALE_FORM'),
  ...funcs,
  "function rowErrText(e){return 'ROWERR:'+((e&&e.message)||'')}",
  'let rowBusy=false; function rowSetBusy(on){rowBusy=on}',
  'const ICON={x:"X"};'
].join('\n'));

const plain = v => JSON.parse(JSON.stringify(v));   // results from the vm have their own Object prototype

function fixtures() {
  const phones = [
    { Model: 'iPhone 13', Status: 'SOLD', 'Purchase Price': 400, 'Purchase Date': '2026-10-01', 'Sale Price': 600, 'Sale Date': '2026-10-10', 'Sold To': 'Mia', 'Device Label': 'iPhone 13 - Blue', IMEI: '356789012345678', 'Clicks on Listing': 12, 'Asking Price': 650, Profit: 200, 'ROI%': 0.5, 'Days Held': 9 },
    { Model: 'Pixel 6', Status: 'IN INVENTORY', 'Purchase Price': 250, 'Purchase Date': '2026-09-05', 'Device Label': 'Pixel 6 - Black', IMEI: '111111111111111' }
  ];
  const bought = [
    { 'Timestamp': '2026-10-01T10:00:00', 'Row ID': 'ab12', 'Serial Number': '356789012345678', 'Phone Model': 'iPhone 13' },
    { 'Timestamp': '2026-09-05T10:00:00', 'Row ID': 'ab13', 'Serial Number': '111111111111111', 'Phone Model': 'Pixel 6' }
  ];
  const sold = { 'Timestamp': '2026-10-10T12:00:00', 'Row ID': 'sd56', 'Device Label': 'iPhone 13 - Blue', 'Sale Price': 600, 'Asking Price': 650, 'Sale Date': '2026-10-10', 'Clicks on Listing': 12, "Buyer's Name": 'Mia', 'Phone Number': null, 'Meetup Location/Address': 'Square One', 'Notes': null };
  const decoy = { ...sold, 'Row ID': 'sd99', 'Device Label': 'iPhone 12 - Red', 'Sale Price': 400, "Buyer's Name": 'Bob' };
  const raw = {
    Expenses: { sheet: 'Expenses', headers: [], rows: [] },
    Phones: { sheet: 'Master Inventory', headers: Object.keys(phones[0]), rows: phones },
    BoughtPhones: { sheet: 'Form Responses - Bought', headers: Object.keys(bought[0]), rows: bought },
    SoldPhones: { sheet: 'Form Responses - Sold', headers: Object.keys(sold), rows: [sold, decoy] }
  };
  return raw;
}
const soldItem = (raw, name = 'iPhone 13') => { ctx.raw = raw; return run(`normalize(raw).items.find(i=>i.name==='${name}')`); };
const planOf = (raw, item) => { ctx.raw = raw; ctx.item = item; return plain(run('dsPlan(item,raw)')); };
const reqOf = plan => { ctx.plan = plan; return plain(run('dsRequest(plan)')); };

test('a sold phone with a matched sale row: the request targets the SOLD tab with Row ID + expect, and nothing else', () => {
  const raw = fixtures();
  const item = soldItem(raw);
  assert.equal(item.sold, true);
  const p = planOf(raw, item);
  assert.equal(p.state, 'ok');
  const r = reqOf(p);
  assert.deepEqual(Object.keys(r).sort(), ['action', 'expect', 'rowId', 'target']);
  assert.equal(r.action, 'delete');
  assert.equal(r.target, 'Form Responses - Sold');
  assert.equal(r.rowId, 'sd56');
  assert.ok(Object.keys(r.expect).length >= 2, 'the script needs at least 2 expect columns');
  assert.ok(!('row' in r), 'no bare row number is ever sent');
});

test('the request NEVER targets a Bought tab (phone, PC, and a forged plan)', () => {
  const raw = fixtures();
  const phoneReq = reqOf(planOf(raw, soldItem(raw)));
  assert.ok(!/bought/i.test(JSON.stringify(phoneReq)));
  assert.notEqual(phoneReq.rowId, 'ab12', 'the purchase Row ID is never sent');

  const pcRaw = {
    BoughtPCs: { sheet: 'Form Responses - PCs', headers: ['Timestamp', 'Row ID', 'Serial Number'], rows: [{ 'Timestamp': 't', 'Row ID': 'pc12', 'Serial Number': 'SN12345' }] },
    SoldPCs: { sheet: 'Form Responses - Sold PCs', headers: ['Timestamp', 'Row ID', 'Device'], rows: [{ 'Timestamp': 't', 'Row ID': 'ps56', 'Device': 'ThinkPad X1 - Black', 'Sale Price': 800, 'Asking Price': 850, 'Sale Date': '2026-10-10', 'Clicks on Listing': 10, 'Sold to': 'Dan' }] }
  };
  const pcItem = { kind: 'PC', name: 'ThinkPad X1', sold: true, label: 'ThinkPad X1 - Black', specs: { 'Serial Number': 'SN12345' } };
  const pcPlan = planOf(pcRaw, pcItem);
  assert.equal(pcPlan.state, 'ok');
  const pcReq = reqOf(pcPlan);
  assert.equal(pcReq.target, 'Form Responses - Sold PCs');
  assert.equal(pcReq.rowId, 'ps56');
  assert.ok(!/bought|Form Responses - PCs"/i.test(JSON.stringify(pcReq)));

  for (const tab of ['Form Responses - Bought', 'Form Responses - PCs', 'Master Inventory', 'PnA', 'Expenses', undefined]) {
    assert.equal(reqOf({ state: 'ok', tab, rowId: 'ab12', expect: { a: 1, b: 2 } }), null, 'forged plan on ' + tab);
  }
  assert.equal(reqOf({ state: 'trade', tab: 'Form Responses - Sold', rowId: 'x', expect: { a: 1, b: 2 } }), null);
  assert.equal(reqOf(null), null);
});

test('trade sales have NO Delete (flag on the item, Trade ID on the sale row, Mixed payment) and no request can be built', () => {
  let raw = fixtures();
  let item = soldItem(raw);
  assert.equal(planOf(raw, { ...item, tradeId: 'T-1001' }).state, 'trade');
  assert.equal(planOf(raw, { ...item, isTradeSale: true }).state, 'trade');

  raw = fixtures();
  raw.SoldPhones.rows[0]['Trade ID'] = 'T-1001';
  const p = planOf(raw, soldItem(raw));
  assert.equal(p.state, 'trade');
  assert.equal(reqOf(p), null);

  raw = fixtures();
  raw.Phones.rows[0]['Payment Type'] = 'Mixed';
  raw.Phones.rows[0]['Trade ID'] = 'T-1002';
  const tradeItem = soldItem(raw);
  assert.equal(tradeItem.isTradeSale, true);
  assert.equal(planOf(raw, tradeItem).state, 'trade');

  raw = fixtures();
  raw.SoldPhones.rows[0]['Trade ID'] = '   ';   // blank is not a trade
  assert.equal(planOf(raw, soldItem(raw)).state, 'ok');
});

test('no Delete for unsold devices, accessories, unmatched, ambiguous or ID-less sales', () => {
  const raw = fixtures();
  const item = soldItem(raw);
  const pixel = soldItem(raw, 'Pixel 6');
  assert.equal(pixel.sold, false);
  assert.equal(planOf(raw, pixel).state, 'unsold');
  assert.equal(reqOf(planOf(raw, pixel)), null);
  assert.equal(planOf(raw, { ...item, kind: 'Accessory' }).state, 'nomatch');
  assert.equal(planOf(raw, null).state, 'nomatch');
  assert.equal(planOf(raw, { ...item, label: 'iPhone 13 - Nobody' }).state, 'nomatch');

  let r2 = fixtures();
  r2.SoldPhones.rows.push({ ...r2.SoldPhones.rows[0], 'Row ID': 'sd57' });   // two sale rows with the same label
  assert.equal(planOf(r2, soldItem(r2)).state, 'nomatch');

  r2 = fixtures();
  r2.SoldPhones.rows[0]['Row ID'] = '';
  assert.equal(planOf(r2, soldItem(r2)).state, 'noid');

  r2 = fixtures();
  r2.BoughtPhones.rows.pop();                                              // purchase row missing: the match is not ok
  r2.BoughtPhones.rows[0]['Serial Number'] = 'DIFFERENT';
  assert.equal(planOf(r2, soldItem(r2)).state, 'nomatch');

  r2 = fixtures();
  const sparse = { 'Timestamp': '2026-10-10T12:00:00', 'Row ID': 'sd56', 'Device Label': 'iPhone 13 - Blue', 'Sale Price': 600 };
  r2.SoldPhones.rows = [sparse];                                           // fewer than 2 other filled columns: cannot verify the row
  assert.equal(planOf(r2, soldItem(r2)).state, 'noexpect');

  r2 = fixtures();
  r2.SoldPhones.sheet = 'Master Inventory';                                // a formula tab is never a target
  assert.equal(planOf(r2, soldItem(r2)).state, 'nomatch');
});

test('after the delete, the device is back in inventory in the COMPUTED data, and nothing else changes', () => {
  const raw = fixtures();
  const before = JSON.parse(JSON.stringify(raw));
  ctx.raw = raw;
  const D1 = plain(run('(()=>{const D=normalize(raw);const s=inventoryStats(D);return {items:D.items,stock:s.stock.map(i=>i.name)}})()'));
  const iph1 = D1.items.find(i => i.name === 'iPhone 13');
  assert.equal(iph1.sold, true);
  assert.equal(iph1.sellPrice, 600);
  assert.ok(!D1.stock.includes('iPhone 13'));

  const item = soldItem(raw);
  ctx.item = item;
  ctx.plan = run('dsPlan(item,raw)');
  const patched = run('dsPatch(raw,item,plan)');
  ctx.patched = patched;
  const D2 = plain(run('(()=>{const D=normalize(patched);const s=inventoryStats(D);return {items:D.items,stock:s.stock.map(i=>i.name),flags:D.flags}})()'));
  const iph2 = D2.items.find(i => i.name === 'iPhone 13');
  assert.equal(iph2.sold, false);
  assert.equal(iph2.status, 'IN INVENTORY');
  assert.equal(iph2.sellPrice, null);
  assert.equal(iph2.sellDate, null);
  assert.equal(iph2.buyer, null);
  assert.equal(iph2.profit, null);
  assert.equal(iph2.buyPrice, 400, 'the purchase price is kept');
  assert.ok(D2.stock.includes('iPhone 13'), 'shows up in stock again');
  assert.equal(D2.items.length, D1.items.length, 'no item appears or disappears');
  const pix1 = D1.items.find(i => i.name === 'Pixel 6');
  const pix2 = D2.items.find(i => i.name === 'Pixel 6');
  assert.deepEqual(pix2, { ...pix1, id: pix2.id }, 'other devices are untouched');

  const P = plain(patched);
  assert.deepEqual(P.BoughtPhones, before.BoughtPhones, 'the purchase tab is untouched');
  assert.equal(P.SoldPhones.rows.length, 1);
  assert.equal(P.SoldPhones.rows[0]['Row ID'], 'sd99', 'only the one sale row went; the other sale stays');
  assert.equal(P.Phones.rows[0]['Device Label'], 'iPhone 13 - Blue');
  assert.equal(P.Phones.rows[0]['Purchase Price'], 400);
  assert.deepEqual(P.Phones.rows[1], before.Phones.rows[1]);
  assert.deepEqual(plain(raw), before, 'the loaded data object is never mutated');

  // and the same device can be matched again as an unsold, purchase-only device
  ctx.item2 = run('normalize(patched).items.find(i=>i.name==="iPhone 13")');
  const m = plain(run('matchDeviceRows(item2,patched)'));
  assert.equal(m.ok, true);
  assert.equal(m.sale, null);
  assert.equal(m.purchase.rowId, 'ab12');
});

test('dsPatch is careful: unknown or duplicate Row ID returns the data untouched; an inventory row that is not SOLD is left alone', () => {
  const raw = fixtures();
  const item = soldItem(raw);
  ctx.raw = raw; ctx.item = item;
  ctx.plan = run('dsPlan(item,raw)');
  ctx.badPlan = { ...plain(ctx.plan), rowId: 'nope' };
  assert.equal(run('dsPatch(raw,item,badPlan)'), raw);
  const dup = fixtures();
  dup.SoldPhones.rows.push({ ...dup.SoldPhones.rows[0] });
  ctx.dup = dup;
  assert.equal(run('dsPatch(dup,item,plan)'), dup);
  assert.equal(run('dsPatch(null,item,plan)'), null);

  const notSold = fixtures();
  notSold.Phones.rows[0].Status = 'IN INVENTORY';
  ctx.notSold = notSold;
  const out = plain(run('dsPatch(notSold,item,plan)'));
  assert.equal(out.SoldPhones.rows.length, 1);
  assert.deepEqual(out.Phones, plain(notSold.Phones));
});

test('error text: clear sentences for every refusal, and the existing text for the rest', () => {
  const t = m => { ctx.err = m === null ? null : new Error(m); return run('dsErrText(err)'); };
  assert.match(t('trade sale: edit it or fix it by hand'), /trade sale.*Nothing was changed/);
  assert.match(t('edit log unavailable'), /safety log.*nothing was deleted/);
  assert.match(t('edit log write failed'), /safety log.*nothing was deleted/);
  assert.match(t('tab needs exactly one Trade ID column'), /Trade ID column.*Nothing was changed/);
  assert.match(t('tab not allowed: Form Responses - Sold'), /newest version.*delete sales.*Nothing was changed/);
  assert.equal(t('row changed'), 'ROWERR:row changed');
  assert.equal(t(null), 'ROWERR:');
});

// ---- drawer footer + confirm dialog + the send/refresh flow, with the browser pieces stubbed ----
function drawer(raw, item) {
  ctx.store = { base: raw, raw, D: { byId: new Map([[item.id || 'i0', { type: 'item', o: item }]]) }, source: { kind: 'google' }, set: v => { ctx.stored = v; } };
  item.id = item.id || 'i0';
  ctx.item = item;
}

test('footer: Delete is ENABLED for a matched, non-trade sold device and DISABLED (with a reason) for everything else', () => {
  const raw = fixtures();
  const sold = soldItem(raw); sold.id = 'i0';
  drawer(raw, sold);
  const on = run('deviceFootHtml(item)');
  assert.match(on, /<button type="button" class="btn danger" data-act="devdel" data-id="i0"/);
  assert.ok(!/danger" disabled/.test(on));
  assert.match(on, /Edit<\/button>/);

  const pixel = soldItem(raw, 'Pixel 6'); pixel.id = 'i1';
  drawer(raw, pixel);
  const un = run('deviceFootHtml(item)');
  assert.match(un, /danger" disabled/);
  assert.ok(!/data-act="devdel"/.test(un));
  assert.match(un, /Delete purchases directly in Google Sheets/);

  const tr = fixtures(); tr.SoldPhones.rows[0]['Trade ID'] = 'T-9';
  const trItem = soldItem(tr); trItem.id = 'i0';
  drawer(tr, trItem);
  const t = run('deviceFootHtml(item)');
  assert.match(t, /danger" disabled/);
  assert.ok(!/data-act="devdel"/.test(t));
  assert.match(t, /Trade sales can&#39;t be deleted here|Trade sales can't be deleted here/);
});

test('confirm dialog names the device, the sale price and the buyer, in the openRowDelete style', () => {
  const raw = fixtures();
  const item = soldItem(raw); item.id = 'i0';
  drawer(raw, item);
  ctx.shown = null;
  ctx.openOverlay = (h, k) => { ctx.shown = { h, k }; };
  run('openDeviceSaleDelete("i0")');
  const { h, k } = ctx.shown;
  assert.equal(k, 'pal');
  assert.match(h, /role="alertdialog"/);
  assert.match(h, /Delete this sale\?/);
  assert.match(h, /iPhone 13/);
  assert.match(h, /\$600/);
  assert.match(h, /Mia/);
  assert.match(h, /purchase is not deleted/);
  assert.match(h, /data-act="devdelgo" data-id="i0"/);
  assert.match(h, /id="ed-msg"/);

  ctx.shown = null;                                   // a trade sale never opens the dialog
  const tr = fixtures(); tr.SoldPhones.rows[0]['Trade ID'] = 'T-9';
  const trItem = soldItem(tr); trItem.id = 'i0';
  drawer(tr, trItem);
  run('openDeviceSaleDelete("i0")');
  assert.equal(ctx.shown, null);
});

function flow() {
  const log = { calls: [], closed: 0, toasts: [], synced: 0, msg: { textContent: '', hidden: true } };
  ctx.sheetCall = async p => { log.calls.push(JSON.parse(JSON.stringify(p))); if (log.fail) throw new Error(log.fail); return { ok: true }; };
  ctx.closeOverlay = () => { log.closed++; };
  ctx.toast = t => { log.toasts.push(t); };
  ctx.syncSoon = () => { log.synced++; };
  ctx.$ = s => (s === '#ed-msg' ? log.msg : null);
  ctx.stored = undefined;
  return log;
}

test('Delete flow: sends exactly one delete to the Sold tab, then patches the loaded data and re-reads the sheet', async () => {
  const raw = fixtures();
  const item = soldItem(raw); item.id = 'i0';
  drawer(raw, item);
  const log = flow();
  await run('deleteDeviceSaleGo("i0")');
  assert.equal(log.calls.length, 1);
  assert.equal(log.calls[0].action, 'delete');
  assert.equal(log.calls[0].target, 'Form Responses - Sold');
  assert.equal(log.calls[0].rowId, 'sd56');
  assert.ok(!/bought/i.test(JSON.stringify(log.calls[0])));
  assert.ok(ctx.stored, 'the loaded data was updated');
  const stored = plain(ctx.stored);
  assert.equal(stored.SoldPhones.rows.length, 1);
  assert.equal(stored.Phones.rows[0].Status, 'IN INVENTORY');
  assert.equal(stored.BoughtPhones.rows.length, 2);
  assert.equal(log.closed, 1);
  assert.equal(log.synced, 1, 're-read of the sheet is scheduled');
  assert.match(log.toasts[0], /back in inventory/);
  assert.equal(run('rowBusy'), false, 'buttons are released again');
});

test('Delete flow: a refusal shows clear text, changes nothing locally, and releases the buttons', async () => {
  const raw = fixtures();
  const item = soldItem(raw); item.id = 'i0';
  drawer(raw, item);
  const log = flow();
  log.fail = 'trade sale: edit it or fix it by hand';
  await run('deleteDeviceSaleGo("i0")');
  assert.equal(log.calls.length, 1);
  assert.equal(log.msg.hidden, false);
  assert.match(log.msg.textContent, /trade sale.*Nothing was changed/);
  assert.equal(ctx.stored, undefined, 'the loaded data is NOT changed');
  assert.equal(log.closed, 0);
  assert.equal(log.synced, 0);
  assert.equal(run('rowBusy'), false);
});

test('Delete flow: sends nothing at all when the sale no longer matches (trade, unsold, or busy)', async () => {
  const tr = fixtures(); tr.SoldPhones.rows[0]['Trade ID'] = 'T-9';
  const item = soldItem(tr); item.id = 'i0';
  drawer(tr, item);
  let log = flow();
  await run('deleteDeviceSaleGo("i0")');
  assert.equal(log.calls.length, 0);
  assert.match(log.msg.textContent, /Could not match this sale any more/);

  const raw = fixtures();
  const ok = soldItem(raw); ok.id = 'i0';
  drawer(raw, ok);
  log = flow();
  run('rowBusy=true');
  await run('deleteDeviceSaleGo("i0")');
  assert.equal(log.calls.length, 0, 'a second tap while busy does nothing');
  run('rowBusy=false');
});

test('SAFETY SCAN: the delete section has exactly one send, sends the plan request only, and never names a purchase or formula tab', () => {
  const region = between('/* ================= DELETE ONE SALE ROW FROM A DEVICE', '/* ================= EDIT ONE PURCHASE ROW FROM A DEVICE').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(region.length > 1500);
  assert.equal(region.split('sheetCall(').length - 1, 1, 'exactly one sheetCall');
  assert.ok(region.includes('sheetCall(req)'), 'it sends the request built by dsRequest');
  assert.ok(region.includes('const req=dsRequest(plan)'));
  for (const bad of ['Bought', 'Form Responses', 'Master Inventory', "'PnA'", "'Summary'", 'BoughtPhones', 'BoughtPCs', "action:'edit'", "action:'undo'"]) {
    assert.ok(!region.includes(bad), 'delete section must not mention ' + bad);
  }
  assert.equal(region.split("action:'delete'").length - 1, 1, 'one delete request, in dsRequest');
  // the only PCs mention is dsPatch picking the LOCAL inventory rows (raw.PCs) to flip back to in-inventory; it is never a send target
  assert.equal(region.split("'PCs'").length - 1, 1);
  assert.ok(region.includes("const invKey=item&&item.kind==='Phone'?'Phones':'PCs';"));
  assert.ok(region.includes('DE_SALE_TABS.includes(plan.tab)'));
  // the edit section still has no delete, and the dispatch is wired
  const edit = between('/* ================= EDIT ONE PURCHASE ROW FROM A DEVICE', '/* ================= COMMAND PALETTE').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/action:'delete'/.test(edit));
  assert.ok(html.includes("case 'devdel':openDeviceSaleDelete(d.id);break;"));
  assert.ok(html.includes("case 'devdelgo':deleteDeviceSaleGo(d.id);break;"));
});
