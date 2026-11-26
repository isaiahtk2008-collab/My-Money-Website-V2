// Run with: node --test tests/expense-type-filter.test.mjs
// Spending view "Whose expense?" filter + "Sort purchases" control (index.html). Loads the REAL code out of index.html (no copies) and proves:
//  - the sheet's values (Personal / For Others / Business) are only RELABELLED on screen (Myself / Others / Business), never changed
//  - the filter really narrows spendRows() to one type, and Untagged rows can still be isolated
//  - the buttons show the right pressed state, include per-type totals, and keep any unexpected value found in the sheet
//  - the two new click actions exist and only touch the on-screen filter / table sort (no sheet calls)
//  - nothing outside index.html changed (the Apps Script and sheet code are untouched)
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
function constLine(n) { const m = html.match(new RegExp('^const ' + n + '=', 'm')); if (!m) throw new Error('const ' + n + ' missing'); const lines = html.slice(m.index).split('\n'); let code = ''; for (const l of lines) { code += (code ? '\n' : '') + l; try { new Function(code); return code; } catch (e) {} } throw new Error('const ' + n + ' unparsable'); }
function fnBlock(name) { const s = html.indexOf('function ' + name + '('); if (s < 0) throw new Error('fn ' + name + ' missing'); let i = html.indexOf('{', html.indexOf(')', s)), d = 0; for (; i < html.length; i++) { if (html[i] === '{') d++; else if (html[i] === '}') { d--; if (!d) return html.slice(s, i + 1); } } throw new Error('unbalanced ' + name); }

const ctx = vm.createContext({ Math, Date, Set, Map, Array, Object, JSON, Number, String, RegExp, console });
ctx.S = { F: {} };
ctx.TS = {};
ctx.M = v => '$' + v;
ctx.esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
vm.runInContext([...['inR', 'TAG_OPTS', 'tagLabel', 'TX_SORTS'].map(constLine), ...['spendRows', 'typeFilterRow'].map(fnBlock),
  'globalThis.__t={spendRows,typeFilterRow,tagLabel,TAG_OPTS,TX_SORTS};'].join('\n'), ctx);
const T = ctx.__t;

const d = (m, day) => new Date(2026, m - 1, day);
const EXP = [
  { id: 'e0', date: d(11, 1), amount: 40, category: 'Food & Dining', tag: 'Personal' },
  { id: 'e1', date: d(11, 2), amount: 120, category: 'Electronics & Tech', tag: 'Business' },
  { id: 'e2', date: d(11, 3), amount: 30, category: 'Gifts & Donations', tag: 'For Others' },
  { id: 'e3', date: d(11, 4), amount: 15, category: 'Groceries', tag: null },
  { id: 'e4', date: d(11, 5), amount: -20, category: 'Shopping', tag: 'Business', isRefund: true },
];
const D = { expenses: EXP };
const R = { start: d(10, 1), end: d(11, 30) };
const ids = rows => rows.map(r => r.id).sort().join(',');

test('sheet values are relabelled for display only', () => {
  assert.equal(T.tagLabel('Personal'), 'Myself');
  assert.equal(T.tagLabel('For Others'), 'Others');
  assert.equal(T.tagLabel('Business'), 'Business');
  assert.equal(T.tagLabel('Untagged'), 'Untagged');
  assert.equal(T.tagLabel(null), null);
  // the values the filter compares against are still the exact strings the sheet form writes
  assert.deepEqual(Array.from(T.TAG_OPTS, o => o[0]), ['Personal', 'For Others', 'Business']);
});

test('the filter narrows purchases to one type (refunds stay out, Untagged can be isolated)', () => {
  assert.equal(ids(T.spendRows(D, R, {})), 'e0,e1,e2,e3');
  assert.equal(ids(T.spendRows(D, R, { tag: 'Personal' })), 'e0');
  assert.equal(ids(T.spendRows(D, R, { tag: 'For Others' })), 'e2');
  assert.equal(ids(T.spendRows(D, R, { tag: 'Business' })), 'e1');
  assert.equal(ids(T.spendRows(D, R, { tag: 'Untagged' })), 'e3');
  assert.equal(ids(T.spendRows(D, R, { tag: 'Business', cat: 'Electronics & Tech' })), 'e1'); // still combines with other filters
  assert.equal(ids(T.spendRows(D, R, { tag: 'Business', cat: 'Groceries' })), '');
});

test('buttons: All is pressed by default, each type shows its total, nothing is lost', () => {
  ctx.S.F = {}; ctx.TS = {};
  const ss = { tags: [{ k: 'Personal', v: 40, n: 1 }, { k: 'Business', v: 120, n: 1 }, { k: 'For Others', v: 30, n: 1 }, { k: 'Untagged', v: 15, n: 1 }] };
  const h = T.typeFilterRow(ss);
  assert.match(h, /data-act="tagf" data-v="" aria-pressed="true">All</);
  assert.match(h, /data-v="Personal" aria-pressed="false">Myself<span>\$40<\/span>/);
  assert.match(h, /data-v="For Others" aria-pressed="false">Others<span>\$30<\/span>/);
  assert.match(h, /data-v="Business" aria-pressed="false">Business<span>\$120<\/span>/);
  assert.match(h, /data-v="Untagged" aria-pressed="false">Untagged<span>\$15<\/span>/);
  assert.match(h, /data-act="txsort" data-k="date" data-dir="-1" aria-pressed="true">Newest/);
});

test('a selected type is the only one pressed, and an unexpected sheet value is still offered', () => {
  ctx.S.F = { tag: 'Business' };
  let h = T.typeFilterRow({ tags: [{ k: 'Business', v: 120, n: 1 }] });
  assert.match(h, /data-v="" aria-pressed="false">All/);
  assert.match(h, /data-v="Business" aria-pressed="true"/);
  assert.match(h, /data-v="Personal" aria-pressed="false">Myself</); // types with no rows in range still appear (no amount)
  ctx.S.F = { tag: 'Side hustle' };
  h = T.typeFilterRow({ tags: [{ k: 'Side hustle', v: 9, n: 1 }, { k: 'Gift', v: 5, n: 1 }] });
  assert.match(h, /data-v="Side hustle" aria-pressed="true"/);
  assert.match(h, /data-v="Gift" aria-pressed="false"/);
  ctx.S.F = {};
});

test('the sort buttons reflect the table\'s current sort', () => {
  ctx.TS = { tx: { sort: { k: 'tag', dir: 1 } } };
  const h = T.typeFilterRow({ tags: [] });
  assert.match(h, /data-k="tag" data-dir="1" aria-pressed="true">By type/);
  assert.match(h, /data-k="date" data-dir="-1" aria-pressed="false">Newest/);
  ctx.TS = { tx: { sort: { k: 'amount', dir: -1 } } };
  assert.match(T.typeFilterRow({ tags: [] }), /data-k="amount" data-dir="-1" aria-pressed="true">Biggest/);
  ctx.TS = {};
});

test('new click actions only change the on-screen filter / sort (no sheet calls)', () => {
  const a = html.match(/case 'tagf':[^\n]*/)[0];
  const b = html.match(/case 'txsort':[^\n]*/)[0];
  assert.equal(a, "case 'tagf':S.F.tag=d.v||null;render();break;");
  assert.ok(/render\(\)/.test(b) && !/sheetCall|fetch|store\.set|patchExpenses/.test(b));
  // the spending view mounts the new row, and the table still supports header-click sorting
  assert.ok(/\$\{typeFilterRow\(ss\)\}/.test(html));
  assert.ok(/data-act="tsort"/.test(html));
});

test('only index.html (plus this test) changed: Apps Script, service worker and sheet code are untouched', () => {
  let changed = [];
  try { changed = execSync('git diff --name-only HEAD', { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean); } catch (e) { return; } // not a git checkout: nothing to compare
  const extra = changed.filter(f => f !== 'index.html' && !f.startsWith('tests/expense-type-filter'));
  assert.deepEqual(extra, []);
});
