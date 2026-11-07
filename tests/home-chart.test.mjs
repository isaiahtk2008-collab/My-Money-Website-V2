// Run with: node --test tests/home-chart.test.mjs
// "Money in and out, last 12 months" chart refinements (index.html). Loads the REAL functions out of index.html (no copies) and proves:
//  - Y axis runs in $500 steps with 12% headroom above the top step, and never below $0 unless Net Profit dips negative
//  - the peak callout picks the highest positive month; the Net Profit series is profit minus spending
//  - the line uses monotone interpolation, gridlines are faded, the tooltip lists Reselling profit before Spending
//  - the glow and peak-pill plugins draw on a fake canvas without throwing, and do nothing when there is nothing to draw
//  - the header has the legend badges + the Net Profit switch, and the shared baseOpts() is untouched
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
const consts = ['nf0', 'nf2', 'mny', 'compact'].map(constLine);
const funcs = ['homeYMax', 'homeYMin', 'homePeak', 'homeNet', 'fadeColor', 'homeControls', 'homeChartConfig'].map(fnBlock);
const ctx = vm.createContext({ Intl, Math, Date, Set, Map, Array, Object, JSON, Number, String, RegExp, console });
vm.runInContext([...consts, ...funcs, 'globalThis.__t={homeYMax,homeYMin,homePeak,homeNet,fadeColor,homeControls,homeChartConfig,mny};'].join('\n'), ctx);
const T = ctx.__t;
const plain = x => JSON.parse(JSON.stringify(x));

// Numbers read off the screenshot: 13 months, July is the record month.
const LABELS = ['Nov', 'Dec', "Jan '26", 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov'];
const SP = [130, 720, 580, 250, 410, 630, 520, 380, 960, 950, 1380, 630, 0];
const PR = [190, 600, 430, 1080, 1030, 1510, 1260, 680, 2936, 890, 2170, 1190, 0];
const UI = { ink: '#c0c8d4', grid: '#363e4c', bar: '#f5a54a', ln: '#4fd1b8', net: '#7fb0ff', bg: '#0e1116', ink2: '#e9ecf1', privacy: false, still: true };

test('Y axis: $500 steps with 12% headroom above the top step', () => {
  assert.equal(T.homeYMax([...SP, ...PR]), 3360); // top step $3,000 * 1.12
  assert.equal(T.homeYMax([1, 2]), 560);          // never smaller than the $500 step
  assert.equal(T.homeYMax([]), 560);
  assert.equal(T.homeYMax([null, undefined, 'x']), 560);
  const r = T.homeYMax([3001]) / 3500;            // 3001 rounds up to the $3,500 step
  assert.ok(r > 1.1 && r < 1.15);
  for (const v of [2936, 3000, 3001, 120, 9999]) { const m = T.homeYMax([v]); assert.ok(m >= v * 1.1 - 1, 'headroom for ' + v); }
});

test('Y axis minimum is $0 unless Net Profit is shown and goes negative', () => {
  const net = T.homeNet(PR, SP);
  assert.equal(T.homeYMin(net, false), 0);
  assert.equal(T.homeYMin(net, true), 0 + Math.floor(Math.min(0, ...net) * 1.12 / 500) * 500);
  assert.equal(T.homeYMin([100, 200], true), 0);
  assert.equal(T.homeYMin([-100], true), -500);
  assert.equal(T.homeYMin(undefined, true), 0);
});

test('peak is the highest positive month (July) and nothing when there is no profit', () => {
  assert.equal(T.homePeak(PR), 8);
  assert.equal(LABELS[T.homePeak(PR)], 'Jul');
  assert.equal(T.homePeak([0, 0, 0]), -1);
  assert.equal(T.homePeak([-5, -1]), -1);
  assert.equal(T.homePeak([]), -1);
  assert.equal(T.homePeak([5, 9, 9]), 1); // first wins on a tie
});

test('net profit is profit minus spending, tolerant of bad input', () => {
  assert.deepEqual(plain(T.homeNet([100, 50], [30, 80])), [70, -30]);
  assert.deepEqual(plain(T.homeNet([100, null], [undefined, 5])), [100, -5]);
  assert.deepEqual(plain(T.homeNet(undefined, undefined)), []);
});

test('fadeColor fades #rrggbb and leaves anything else alone', () => {
  assert.equal(T.fadeColor('#363e4c', 0.4), 'rgba(54,62,76,0.4)');
  assert.equal(T.fadeColor('rgb(1,2,3)', 0.4), 'rgb(1,2,3)');
  assert.equal(T.fadeColor('', 0.4), '');
  assert.equal(T.fadeColor(undefined, 0.4), undefined);
});

test('header controls: two colour-coded legend badges plus an accessible Net Profit switch', () => {
  const h = T.homeControls();
  assert.match(h, /hc-badge[^>]*><i class="hc-sw bar"><\/i>Spending/);
  assert.match(h, /hc-badge line[^>]*><i class="hc-sw ln"><\/i>Reselling profit/);
  assert.match(h, /<button[^>]*id="homeNet"[^>]*role="switch"[^>]*aria-checked="false"[^>]*>[\s\S]*Net Profit<\/button>/);
  assert.ok(!/data-act/.test(h), 'must not trigger the app-wide click handlers');
  assert.match(html, /card\('Money in and out, last 12 months',chartBox\('homeChart'\),homeControls\(\)\)/);
});

test('chart config: monotone line, faded grid, $500 ticks, hidden Net Profit line, privacy respected', () => {
  const c = T.homeChartConfig(LABELS, SP, PR, UI), d = c.data.datasets;
  assert.equal(d.length, 3);
  assert.equal(d[0].label, 'Spending'); assert.equal(d[0].type, 'bar');
  assert.equal(d[1].label, 'Reselling profit'); assert.equal(d[1].cubicInterpolationMode, 'monotone'); assert.equal(d[1].tension, 0); assert.equal(d[1].pointRadius, 3);
  assert.equal(d[2].label, 'Net profit'); assert.equal(d[2].hidden, true);
  assert.equal(d[2].data[8], 2936 - 960);
  const y = c.options.scales.y;
  assert.equal(y.min, 0); assert.equal(y.max, 3360); assert.equal(y.ticks.stepSize, 500); assert.equal(y.ticks.includeBounds, false);
  assert.equal(y.grid.color, 'rgba(54,62,76,0.4)');
  assert.deepEqual([0, 500, 1000, 1500, 2000, 2500, 3000].map(y.ticks.callback), ['$0', '$500', '$1k', '$1.5k', '$2k', '$2.5k', '$3k']);
  assert.equal(c.options.scales.x.ticks.maxRotation, 0);
  assert.equal(c.options.plugins.tooltip.enabled, true);
  assert.equal(T.homeChartConfig(LABELS, SP, PR, { ...UI, privacy: true }).options.plugins.tooltip.enabled, false);
  assert.equal(c.options.animation, false);
});

test('tooltip lists Reselling profit first, then Spending, then Net profit, with square swatches', () => {
  const tt = T.homeChartConfig(LABELS, SP, PR, UI).options.plugins.tooltip;
  const items = [{ datasetIndex: 0 }, { datasetIndex: 2 }, { datasetIndex: 1 }];
  assert.deepEqual(plain(items.sort(tt.itemSort).map(i => i.datasetIndex)), [1, 0, 2]);
  assert.equal(tt.callbacks.label({ dataset: { label: 'Reselling profit' }, parsed: { y: 2936 } }), ' Reselling profit: $2,936');
  assert.equal(tt.callbacks.label({ dataset: { label: 'Spending' }, parsed: { y: 960 } }), ' Spending: $960');
  assert.equal(tt.callbacks.labelColor({ dataset: { type: 'bar' } }).backgroundColor, UI.bar);
  assert.equal(tt.callbacks.labelColor({ dataset: { type: 'line', borderColor: UI.ln } }).backgroundColor, UI.ln);
  assert.equal(tt.usePointStyle, false); assert.equal(tt.boxWidth, tt.boxHeight);
});

// A fake chart + canvas context that records what the plugins draw.
function fakeChart({ active, peakHidden = false }) {
  const calls = [], state = {};
  const c = new Proxy({ measureText: t => ({ width: t.length * 6 }) }, {
    get(t, k) { if (k in t) return t[k]; return (...a) => { calls.push([String(k), ...a]); }; },
    set(t, k, v) { t[k] = v; if (k === 'shadowBlur' || k === 'fillStyle') state[k] = v; calls.push(['set:' + k, v]); return true; },
  });
  const bars = LABELS.map((_, i) => ({ getProps: () => ({ x: 50 + i * 40, y: 300 - SP[i] / 12, base: 300, width: 30 }) }));
  const pts = LABELS.map((_, i) => ({ x: 50 + i * 40, y: 300 - PR[i] / 12 }));
  return { calls, state, ch: {
    ctx: c, chartArea: { left: 40, right: 560, top: 20, bottom: 300 },
    tooltip: { getActiveElements: () => active },
    getDatasetMeta: i => i === 0 ? { data: bars } : { hidden: peakHidden, data: pts },
  } };
}
const plug = id => T.homeChartConfig(LABELS, SP, PR, UI).plugins.find(p => p.id === id);

test('glow plugin: glows only the hovered bar, nothing when not hovering', () => {
  const g = plug('homeGlow');
  const a = fakeChart({ active: [{ index: 10 }] }); g.beforeDatasetsDraw(a.ch);
  assert.ok(a.calls.some(x => x[0] === 'set:shadowBlur' && x[1] > 0), 'sets a shadow');
  assert.equal(a.calls.filter(x => x[0] === 'fill').length, 1, 'draws exactly one bar');
  assert.ok(a.calls.some(x => x[0] === 'save') && a.calls.some(x => x[0] === 'restore'), 'restores canvas state');
  const b = fakeChart({ active: [] }); g.beforeDatasetsDraw(b.ch);
  assert.equal(b.calls.length, 0);
  const z = fakeChart({ active: [{ index: 12 }] }); g.beforeDatasetsDraw(z.ch); // Nov: $0 spending, no bar
  assert.equal(z.calls.length, 0);
  assert.doesNotThrow(() => g.beforeDatasetsDraw({}));
});

test('peak pill: draws "MAX: $2,936" above July only, hides while July is hovered or the line is hidden', () => {
  const p = plug('homePeak');
  const a = fakeChart({ active: [] }); p.afterDatasetsDraw(a.ch);
  const txt = a.calls.find(x => x[0] === 'fillText');
  assert.ok(txt && txt[1] === 'MAX: $2,936', 'pill text');
  assert.ok(txt[3] < 300 - 2936 / 12, 'pill sits above the peak point');
  assert.ok(a.calls.some(x => x[0] === 'restore'));
  const h = fakeChart({ active: [{ index: 8 }] }); p.afterDatasetsDraw(h.ch);
  assert.equal(h.calls.length, 0, 'hidden while the July tooltip is open');
  const o = fakeChart({ active: [{ index: 3 }] }); p.afterDatasetsDraw(o.ch);
  assert.ok(o.calls.some(x => x[0] === 'fillText'), 'still shown when hovering another month');
  const hid = fakeChart({ active: [], peakHidden: true }); p.afterDatasetsDraw(hid.ch);
  assert.equal(hid.calls.length, 0);
  const none = T.homeChartConfig(LABELS, [0, 0], [0, 0], UI).plugins.find(x => x.id === 'homePeak');
  const n = fakeChart({ active: [] }); none.afterDatasetsDraw(n.ch);
  assert.equal(n.calls.length, 0, 'no peak when there is no profit');
});

test('safety: shared baseOpts() is unchanged, the old chart is the fallback, nothing writes to the sheet', () => {
  const base = fnBlock('baseOpts');
  assert.match(base, /maxTicksLimit:5/);              // other charts still use the old Y ticks
  assert.match(base, /grid:\{color:grid\}/);          // and the old grid colour
  const v = html.slice(html.indexOf('function vHome('), html.indexOf('/* ---------- Monthly burn rate'));
  assert.match(v, /catch\(e\)\{[\s\S]*baseOpts\(\{legend:false,zero:false\}\)/);
  assert.ok(!/sheetCall|fetch\(|APPS_SCRIPT/.test(fnBlock('homeChartConfig') + fnBlock('homeControls')));
});

test('page scripts still compile', () => {
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  assert.ok(scripts.length > 0);
  for (const s of scripts) assert.doesNotThrow(() => new Function(s));
});
