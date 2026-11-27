// Run with: node --test tests/other-income.test.mjs
// "Other income" (index.html): closed-loan profit/loss and forfeited deposits count in the profit numbers, but stay apart from reselling profit.
// Loads the REAL code out of index.html (no copies) and proves:
//  - owedModel totals gain depForfeited / depForfeitedN; only CLOSED, Forfeited deposits count (Picked Up, Refunded, Waiting never do)
//  - otherIncomeEvents dates each item by the day it closed, loans are signed (loss is negative), open loans are skipped
//  - otherIncomeRange splits this range from the previous one
//  - the chart gets a blue loan band and a deposit band stacked on the reselling line, Net Profit includes them, reselling data is untouched
//  - with no other income nothing changes (no extra datasets, no extra badges)
//  - the Income colours settings card + saved colours (validation, defaults, reset) work
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, '..', 'index.html'), 'utf8');
function fnBlock(name) { const s = html.indexOf('function ' + name + '('); if (s < 0) throw new Error('fn ' + name + ' missing'); let i = html.indexOf('{', html.indexOf(')', s)), d = 0; for (; i < html.length; i++) { if (html[i] === '{') d++; else if (html[i] === '}') { d--; if (!d) return html.slice(s, i + 1); } } throw new Error('unbalanced ' + name); }
function constLine(n) { const m = html.match(new RegExp('^const ' + n + '=', 'm')); if (!m) throw new Error('const ' + n + ' missing'); const lines = html.slice(m.index).split('\n'); let code = ''; for (const l of lines) { code += (code ? '\n' : '') + l; try { new Function(code); return code; } catch (e) {} } throw new Error('const ' + n + ' unparsable'); }

const D = (y, m, d) => new Date(y, m - 1, d);
const pad = n => String(n).padStart(2, '0');
const a = html.indexOf('const OWED_LOAN_STATUSES');
const b = html.indexOf('/* ===== TRADING + PRE-IPO MODELS');
assert.ok(a > 0 && b > a);
const ctx = vm.createContext({
  Intl, Math, Date, Set, Map, Array, Object, JSON, Number, String, RegExp, Boolean, console,
  TODAY: D(2026, 11, 26),
  num: v => { const n = parseFloat(String(v).replace(/[$,]/g, '')); return isNaN(n) ? null : n; },
  pd: v => { if (v instanceof Date) return v; const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || '')); return m ? D(+m[1], +m[2], +m[3]) : null; },
  diffD: (x, y) => Math.round((y - x) / 864e5),
  isoDay: d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()),
  M: n => '$' + n, fdy: d => d.toISOString().slice(0, 10), esc: s => String(s == null ? '' : s),
  store: { D: { items: [] } }, LS: { get: () => null }
});
const consts = ['nf0', 'nf2', 'mny', 'compact'].map(constLine);
const funcs = ['homeYMax', 'homeYMin', 'homePeak', 'homeNet', 'fadeColor', 'homeControls', 'homeChartConfig', 'otherIncomeEvents', 'otherIncomeSum', 'otherIncomeRange', 'incomeColors'].map(fnBlock);
vm.runInContext(html.slice(a, b) + '\n' + consts.join('\n') + '\n' + funcs.join('\n') + '\nglobalThis.__t={owedModel,homeControls,homeChartConfig,otherIncomeEvents,otherIncomeSum,otherIncomeRange,incomeColors,homeNet};', ctx);
const T = ctx.__t;
const plain = x => JSON.parse(JSON.stringify(x));

const loan = o => Object.assign({ 'Row ID': 'L' + Math.random().toString(36).slice(2, 6), Type: 'Loan', Person: 'Ali', 'Item / Device': 'Cash', 'Total Amount': 100, 'Amount Paid': 0, 'Date Out': '2026-10-01', 'Due Date': '2026-12-01', Status: 'Out' }, o);
const dep = o => Object.assign({ 'Row ID': 'D' + Math.random().toString(36).slice(2, 6), Type: 'Deposit', Person: 'Sam', 'Item / Device': 'iPhone 14', 'Total Amount': 600, 'Amount Paid': 100, 'Date Out': '2026-10-05', 'Due Date': '2026-11-01', Status: 'Waiting' }, o);
const model = rows => T.owedModel({ Owed: { rows: rows.map((r, i) => Object.assign({ _row: i + 2 }, r)) } }, ctx.TODAY);
const R = { start: D(2026, 11, 1), end: D(2026, 11, 30), pStart: D(2026, 10, 1), pEnd: D(2026, 10, 31) };

test('only closed Forfeited deposits become profit', () => {
  const m = model([
    dep({ Status: 'Forfeited', 'Amount Paid': 120, 'Date Closed': '2026-11-10' }),
    dep({ Status: 'Picked Up', 'Amount Paid': 100, 'Date Closed': '2026-11-11' }),
    dep({ Status: 'Refunded', 'Amount Paid': 100, 'Date Closed': '2026-11-12' }),
    dep({ Status: 'Waiting', 'Amount Paid': 100 })
  ]);
  assert.equal(m.totals.depForfeited, 120);
  assert.equal(m.totals.depForfeitedN, 1);
  const ev = T.otherIncomeEvents(m);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].kind, 'dep');
  assert.equal(ev[0].amt, 120);
});

test('loans are signed, dated by close day, and open loans are skipped', () => {
  const m = model([
    loan({ Status: 'Returned', 'Amount Paid': 130, 'Date Closed': '2026-11-20' }),
    loan({ Status: 'Written Off', 'Amount Paid': 40, 'Date Closed': '2026-10-15' }),
    loan({ Status: 'Out', 'Amount Paid': 20 }),
    loan({ Status: 'Returned', 'Amount Paid': 100, 'Date Closed': '2026-11-21' }) // even: nothing to add
  ]);
  const ev = T.otherIncomeEvents(m);
  assert.deepEqual(plain(ev.map(e => [e.kind, e.amt])).sort((x, y) => y[1] - x[1]), [['loan', 30], ['loan', -60]]);
});

test('range totals split this range from the previous one', () => {
  const m = model([
    loan({ Status: 'Returned', 'Amount Paid': 130, 'Date Closed': '2026-11-20' }),
    loan({ Status: 'Written Off', 'Amount Paid': 40, 'Date Closed': '2026-10-15' }),
    dep({ Status: 'Forfeited', 'Amount Paid': 120, 'Date Closed': '2026-11-10' })
  ]);
  const r = T.otherIncomeRange(T.otherIncomeEvents(m), R);
  assert.equal(r.loan, 30); assert.equal(r.dep, 120); assert.equal(r.total, 150);
  assert.equal(r.pLoan, -60); assert.equal(r.pTotal, -60); assert.equal(r.any, true);
});

test('no Owed tab or bad input gives no events and never throws', () => {
  assert.deepEqual(plain(T.otherIncomeEvents(null)), []);
  assert.deepEqual(plain(T.otherIncomeEvents({ hasOwed: false })), []);
  const r = T.otherIncomeRange([], R);
  assert.equal(r.total, 0); assert.equal(r.any, false);
});

test('chart: blue loan band + deposit band stack on the reselling line; reselling data untouched; Net includes them', () => {
  const pr = [100, 200], sp = [50, 50];
  const cfg = T.homeChartConfig(['a', 'b'], sp, pr, { ink: '#999', grid: '#333', bar: '#f5a54a', ln: '#4fd1b8', net: '#7fb0ff', bg: '#000', ink2: '#fff', privacy: false, still: true,
    loanAmt: [0, 30], depAmt: [20, 0], loanCol: '#3b82f6', depCol: '#a78bfa' });
  const ds = cfg.data.datasets;
  assert.deepEqual(plain(ds.map(d => d.label)), ['Spending', 'Reselling profit', 'Net profit', 'Loan profit', 'Forfeited deposits']);
  assert.deepEqual(plain(ds[1].data), [100, 200]);          // reselling line unchanged
  assert.deepEqual(plain(ds[2].data), [70, 180]);           // net = 100+20-50, 200+30-50
  assert.deepEqual(plain(ds[3].data), [100, 230]);          // reselling + loans
  assert.deepEqual(plain(ds[4].data), [120, 230]);          // + deposits
  assert.equal(ds[3].borderColor, '#3b82f6');
  assert.equal(ds[3].fill, 1); assert.equal(ds[4].fill, 3);
  assert.equal(ds[2].hidden, true);                          // Net toggle still drives dataset 2
  const lab = cfg.options.plugins.tooltip.callbacks.label;
  assert.match(lab({ dataset: ds[3], dataIndex: 1, parsed: { y: 230 } }), /Loan profit: \$30/);   // tooltip shows the amount, not the stacked total
});

test('chart: deposits only fills down to the reselling line; no other income adds nothing', () => {
  const base = { ink: '#999', grid: '#333', bar: '#f5a54a', ln: '#4fd1b8', net: '#7fb0ff', bg: '#000', ink2: '#fff', privacy: false, still: true };
  const dOnly = T.homeChartConfig(['a'], [10], [100], Object.assign({ loanAmt: [0], depAmt: [40], loanCol: '#3b82f6', depCol: '#a78bfa' }, base)).data.datasets;
  assert.deepEqual(plain(dOnly.map(d => d.label)), ['Spending', 'Reselling profit', 'Net profit', 'Forfeited deposits']);
  assert.equal(dOnly[3].fill, 1);
  const none = T.homeChartConfig(['a'], [10], [100], base).data.datasets;
  assert.equal(none.length, 3);
});

test('legend badges only appear for sources that have data', () => {
  assert.ok(!/oi-loan|oi-dep/.test(T.homeControls()));
  assert.ok(/oi-loan/.test(T.homeControls({ loan: true })) && !/oi-dep/.test(T.homeControls({ loan: true })));
  assert.ok(/oi-dep/.test(T.homeControls({ dep: true })));
});

// ---- Settings > Income colours ----
function loadColors(stored) {
  const m = html.match(/<script id="mm-income-colors">([\s\S]*?)<\/script>/);
  assert.ok(m, 'income colours script missing');
  const store = new Map(stored ? [['mm.inc.col', stored]] : []);
  const styles = {};
  const w = {
    localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) },
    document: { documentElement: { style: { setProperty: (k, v) => { styles[k] = v; } } }, addEventListener() {}, getElementById: () => null },
  };
  w.window = w;
  const c = vm.createContext(Object.assign(w, { JSON, console, RegExp }));
  vm.runInContext(m[1], c);
  return { w, styles, store };
}

test('colours default to blue / purple / pink and are applied as CSS variables', () => {
  const { w, styles } = loadColors();
  assert.deepEqual(plain(w.mmIncColors()), { loan: '#3b82f6', dep: '#a78bfa', pay: '#f472b6' });
  assert.equal(styles['--oi-loan'], '#3b82f6'); assert.equal(styles['--oi-dep'], '#a78bfa'); assert.equal(styles['--oi-pay'], '#f472b6');
});

test('saved colours load; invalid ones fall back to the default', () => {
  const { w } = loadColors(JSON.stringify({ loan: '#112233', dep: 'red', pay: '#ABCDEF' }));
  assert.deepEqual(plain(w.mmIncColors()), { loan: '#112233', dep: '#a78bfa', pay: '#ABCDEF' });
  const bad = loadColors('{not json');
  assert.equal(bad.w.mmIncColors().loan, '#3b82f6');
});

test('settings card lists loan, deposits and paychecks pickers plus a reset button; panel includes the card', () => {
  const { w } = loadColors();
  const card = w.__mmIncomeColorsHtml();
  for (const k of ['loan', 'dep', 'pay']) assert.ok(card.includes('data-inc-col="' + k + '"'), k);
  assert.ok(card.includes('data-inc-reset'));
  assert.ok(html.includes("window.__mmIncomeColorsHtml==='function'?window.__mmIncomeColorsHtml()"));
});

test('Home and Reselling tiles switch to "Total profit" only when other income exists', () => {
  const home = html.slice(html.indexOf('function vHome()'), html.indexOf('/* ---------- Monthly burn rate'));
  assert.ok(home.includes("label:'Total profit'") && home.includes("label:'Reselling profit'"));
  const res = html.slice(html.indexOf('function vReselling()'), html.indexOf('function vReselling()') + 4000);
  assert.ok(res.includes("label:'Total profit'") && res.includes("label:'Profit'"));
  assert.ok(res.includes("k==='All'"));
});
