// Run with: node tests/draft-sync.test.mjs
// Loads the REAL draftState and syncUrgency out of index.html (no copies) and checks the two rules behind the violet draft look and the red sync glow:
// a saved draft is calm for 24 hours and then "stale" (it glows); a queued entry that failed to send, or has waited 24 hours, is urgent.
// Both are pure: bad input never throws, and nothing is read from or written to storage.
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, '..', 'index.html'), 'utf8');

function fnBlock(name) {
  const start = html.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('function ' + name + ' not found in index.html');
  let i = html.indexOf('{', html.indexOf(')', start)), depth = 0;
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (depth === 0) return html.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces in ' + name);
}

const ctx = vm.createContext({ Date, Number, Array, Object });
vm.runInContext([fnBlock('draftState'), fnBlock('syncUrgency'), 'this.draftState=draftState;this.syncUrgency=syncUrgency;'].join('\n'), ctx);

const H = 3600 * 1000, NOW = 1_800_000_000_000;
// results are plain values, so a JSON round trip lets strict comparisons ignore the sandbox's own Object prototype
const ds = (d, n = NOW) => JSON.parse(JSON.stringify(ctx.draftState(d, n)));
const su = (q, n = NOW) => JSON.parse(JSON.stringify(ctx.syncUrgency(q, n)));

let passed = 0;
function test(name, fn) { fn(); passed++; console.log('ok -', name); }

test('draftState: no draft, empty draft and a draft with no values are null', () => {
  assert.equal(ds(null), null); assert.equal(ds(undefined), null); assert.equal(ds({}), null); assert.equal(ds({ ts: NOW }), null);
});
test('draftState: fresh until exactly 24 hours, then stale', () => {
  assert.equal(ds({ v: { a: 1 }, ts: NOW - 1000 }), 'fresh');
  assert.equal(ds({ v: { a: 1 }, ts: NOW - 24 * H + 1 }), 'fresh');
  assert.equal(ds({ v: { a: 1 }, ts: NOW - 24 * H }), 'stale');
  assert.equal(ds({ v: { a: 1 }, ts: NOW - 90 * H }), 'stale');
});
test('draftState: a missing or invalid timestamp is fresh, never stale', () => {
  for (const ts of [undefined, null, 'x', NaN, Infinity]) assert.equal(ds({ v: { a: 1 }, ts }), 'fresh');
});

test('syncUrgency: empty and junk queues are calm and never throw', () => {
  for (const q of [undefined, null, 5, 'x', {}, [], [null, 3, 'a']]) { const r = su(q); assert.equal(r.urgent, false); assert.equal(r.n, 0); }
});
test('syncUrgency: recent entries wait calmly', () => {
  assert.deepEqual(su([{ ts: NOW - 2 * H }, { ts: NOW - 1000 }]), { n: 2, failed: 0, stale: 0, urgent: false });
});
test('syncUrgency: a failed entry is urgent straight away', () => {
  const r = su([{ ts: NOW, err: 'Script needs updating' }, { ts: NOW }]);
  assert.equal(r.urgent, true); assert.equal(r.failed, 1); assert.equal(r.n, 2);
});
test('syncUrgency: an entry waiting 24 hours or more is urgent', () => {
  assert.equal(su([{ ts: NOW - 24 * H }]).urgent, true);
  assert.equal(su([{ ts: NOW - 24 * H + 1 }]).urgent, false);
  assert.equal(su([{}]).urgent, false, 'no timestamp is never treated as stale');
});
test('syncUrgency: an empty err string is not a failure', () => {
  assert.equal(su([{ ts: NOW, err: '' }]).failed, 0);
});
test('the input queue is never changed', () => {
  const q = [{ ts: NOW - 30 * H, err: 'x' }, { ts: NOW }];
  const before = JSON.stringify(q);
  ctx.syncUrgency(q, NOW);
  assert.equal(JSON.stringify(q), before);
});

console.log(`\n${passed} passed`);
