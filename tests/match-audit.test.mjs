// Run with: node --test tests/match-audit.test.mjs
// Loads the REAL functions from index.html (no copies) and proves:
//  - pcSerialOf reads the PCs tab header "Serial Number:" (colon) and "Serial Number"
//  - PCs now match their purchase/sale rows (they used to fail: nothing ever set item.serial)
//  - the [KEY] label fallback is PC-only, needs exactly one purchase serial ending with the key, and never touches phones
//  - matchAudit only reports (never throws, never writes) and explains every failure
//  - the toolbar button, click routes and PC serial line are wired in, and the popup escapes everything
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

const ctx = vm.createContext({ ICON: { x: '<i>x</i>' } });
vm.runInContext([
  constLine('esc'),
  fnBlock('matchDeviceRows'),
  fnBlock('pcSerialOf'),
  fnBlock('matchAudit'),
  fnBlock('matchCheckHtml'),
  'globalThis.__t={matchDeviceRows,pcSerialOf,matchAudit,matchCheckHtml};'
].join('\n'), ctx);
const { pcSerialOf, matchDeviceRows, matchAudit, matchCheckHtml } = ctx.__t;
const plain = x => JSON.parse(JSON.stringify(x));

const LAB = 'Asus TUF Gaming FX05DT (Black) • $350 • Obada • [6F5AF0]';
const SER = 'BF46CA2F-011D-446B-B075-1BC8F36F5AF0';
const rawOf = (over = {}) => Object.assign({
  BoughtPhones: { sheet: 'Form Responses - Bought', rows: [] },
  BoughtPCs: { sheet: 'Form Responses - PCs', rows: [{ 'Row ID': 'p1', 'Serial Number': SER }] },
  SoldPhones: { sheet: 'Form Responses - Sold', rows: [] },
  SoldPCs: { sheet: 'Form Responses - Sold PCs', rows: [{ 'Row ID': 's1', Device: LAB }] }
}, over);

test('pcSerialOf: tolerant header lookup', () => {
  assert.equal(pcSerialOf({ 'Serial Number:': '  SN-ABC-123  ' }), 'SN-ABC-123');
  assert.equal(pcSerialOf({ 'Serial Number': 'XYZ789' }), 'XYZ789');
  assert.equal(pcSerialOf({ 'Serial Number:': '   ' }), null);
  assert.equal(pcSerialOf({ 'Serial Number:': null }), null);
  assert.equal(pcSerialOf({ 'IMEI Key': 'ABCDEF' }), null);
  assert.equal(pcSerialOf(null), null);
  assert.equal(pcSerialOf({}), null);
});

test('a sold PC and an unsold PC match through item.serial', () => {
  const sold = plain(matchDeviceRows({ kind: 'PC', serial: SER, label: LAB, sold: true }, rawOf()));
  assert.equal(sold.ok, true);
  assert.equal(sold.purchase.rowId, 'p1');
  assert.equal(sold.sale.rowId, 's1');
  const unsold = plain(matchDeviceRows({ kind: 'PC', serial: SER, label: LAB, sold: false }, rawOf()));
  assert.equal(unsold.ok, true);
  assert.equal(unsold.sale, null);
});

test('PC fallback through the [KEY] at the end of the label', () => {
  const item = { kind: 'PC', serial: null, label: LAB, sold: false };
  assert.equal(plain(matchDeviceRows(item, rawOf())).ok, true);
  const two = rawOf({ BoughtPCs: { sheet: 'x', rows: [{ 'Serial Number': 'AAAA6F5AF0' }, { 'Serial Number': 'BBBB6F5AF0' }] } });
  assert.equal(plain(matchDeviceRows(item, two)).ok, false);
  const none = rawOf({ BoughtPCs: { sheet: 'x', rows: [{ 'Serial Number': 'ZZZZZZZZ' }] } });
  assert.equal(plain(matchDeviceRows(item, none)).ok, false);
  assert.equal(plain(matchDeviceRows({ kind: 'PC', serial: null, label: 'No key here', sold: false }, rawOf())).ok, false);
});

test('the fallback never applies to phones', () => {
  const raw = rawOf({ BoughtPhones: { sheet: 'x', rows: [{ 'Serial Number': '3050123456F5AF0' }] } });
  assert.equal(plain(matchDeviceRows({ kind: 'Phone', label: 'iPhone [6F5AF0]', sold: false }, raw)).ok, false);
});

test('duplicate serial, missing purchase tab, and sold-without-label all fail safely', () => {
  const dup = rawOf({ BoughtPCs: { sheet: 'x', rows: [{ 'Serial Number': SER }, { 'Serial Number': SER }] } });
  assert.equal(plain(matchDeviceRows({ kind: 'PC', serial: SER, label: LAB }, dup)).ok, false);
  assert.equal(plain(matchDeviceRows({ kind: 'PC', serial: SER, label: LAB }, { BoughtPhones: { rows: [] } })).ok, false);
  assert.equal(plain(matchDeviceRows({ kind: 'PC', serial: SER, label: '', sold: true }, rawOf())).ok, false);
});

test('regression: a phone with an IMEI still matches exactly as before', () => {
  const raw = rawOf({
    BoughtPhones: { sheet: 'Form Responses - Bought', rows: [{ 'Row ID': 'b1', 'Serial Number': 'R3CX30MLB9W' }] },
    SoldPhones: { sheet: 'Form Responses - Sold', rows: [{ 'Row ID': 'z1', 'Device Label': 'Samsung S24' }] }
  });
  const res = plain(matchDeviceRows({ kind: 'Phone', sold: true, label: 'Samsung S24', specs: { IMEI: 'r3cx30mlb9w' } }, raw));
  assert.equal(res.ok, true);
  assert.equal(res.purchase.rowId, 'b1');
  assert.equal(res.sale.rowId, 'z1');
});

test('matchAudit: counts, reasons, missing IDs, and it never throws', () => {
  const raw = {
    BoughtPhones: { rows: [{ 'Row ID': 'b1', 'Serial Number': 'IMEI111' }] },
    BoughtPCs: { rows: [
      { 'Row ID': 'c1', 'Serial Number': 'PCSN1' },
      { 'Serial Number': 'PCSN2_NOID' },
      { 'Row ID': 'c3a', 'Serial Number': 'PCSN_DUP' },
      { 'Row ID': 'c3b', 'Serial Number': 'PCSN_DUP' }
    ] },
    SoldPhones: { rows: [] },
    SoldPCs: { rows: [] }
  };
  const items = [
    { id: 1, kind: 'PC', serial: 'PCSN1', label: 'PC 1' },
    { id: 2, kind: 'PC', serial: 'PCSN2_NOID', label: 'PC 2' },
    { id: 3, kind: 'Phone', label: 'Phone no serial' },
    { id: 4, kind: 'PC', serial: 'NOPE', label: 'PC missing' },
    { id: 5, kind: 'PC', serial: 'PCSN_DUP', label: 'PC dup' },
    { id: 6, kind: 'Phone', serial: 'IMEI111', label: 'Sold phone', sold: true }
  ];
  const a = plain(matchAudit(items, raw));
  assert.equal(a.total, 6);
  assert.equal(a.okCount, 1);
  assert.equal(a.noIdCount, 1);
  assert.deepEqual(a.problems.map(p => [p.id, p.reason]), [[2, 'noid'], [3, 'no-serial'], [4, 'no-purchase-row'], [5, 'several-purchase-rows'], [6, 'no-sale-row']]);
  assert.equal(plain(matchAudit(items, {})).problems[0].reason, 'no-script-tabs');
  assert.deepEqual(plain(matchAudit(null, null)), { total: 0, okCount: 0, noIdCount: 0, problems: [] });
  assert.doesNotThrow(() => matchAudit([null, undefined, 123, 'x', {}], null));
});

test('matchAudit: a sale row whose label is blank is never "matched" to a blank cell', () => {
  const raw = rawOf({ SoldPCs: { rows: [{ 'Row ID': 's9', Device: '' }] } });
  const a = plain(matchAudit([{ id: 1, kind: 'PC', serial: SER, label: '', sold: true, name: 'X' }], raw));
  assert.equal(a.problems[0].reason, 'no-sale-row');
});

test('popup: escapes everything, offers Fill missing IDs only when needed', () => {
  const bad = { total: 2, okCount: 0, noIdCount: 1, problems: [
    { id: 1, name: '<img src=x onerror=alert(1)>', kind: 'PC', reason: 'noid', detail: '<b>d</b>' },
    { id: 2, name: 'Fine', kind: 'PC', reason: 'no-serial', detail: 'No serial.' }
  ] };
  const h = matchCheckHtml(bad);
  assert.ok(!h.includes('<img'));
  assert.ok(!h.includes('<b>d</b>'));
  assert.ok(h.includes('data-act="idfill"'));
  assert.ok(h.includes('data-act="matchrefix"'));
  const good = matchCheckHtml({ total: 3, okCount: 3, noIdCount: 0, problems: [] });
  assert.ok(good.includes('All 3 devices match'));
  assert.ok(!good.includes('data-act="idfill"'));
});

test('wiring: toolbar button, click routes, PC serial line, no new sheet writes', () => {
  assert.ok(html.includes('data-act="matchfix"'));
  assert.ok(html.includes("case 'matchfix':openMatchCheck();break;"));
  assert.ok(html.includes("case 'matchrefix':matchRecheck();break;"));
  assert.ok(html.includes("if(def.kind==='PC'){it.serial=typeof pcSerialOf==='function'?pcSerialOf(r):null;"));
  const ui = fnBlock('openMatchCheck') + fnBlock('matchRecheck') + fnBlock('matchCheckHtml') + fnBlock('matchAudit');
  assert.ok(!/sheetCall|fetch\(/.test(ui), 'the check must never write to or call the sheet');
});
