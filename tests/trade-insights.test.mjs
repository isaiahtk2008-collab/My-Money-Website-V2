// Run with: node --test tests/trade-insights.test.mjs
// The two stock insights that talk about "cash" (in02, in04) must count REAL cash only.
// Trade-in value is never cash. Plain rows (cashSpent === buyPrice) give the same numbers as before.
// Loads the real insight code out of index.html (no copies).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, '..', 'index.html'), 'utf8');

test('stock insights count real cash only (trade value is not cash)', () => {
  const matchIn02 = html.match(/\{id:'in02',run:c=>[\s\S]*?\}\}\},/);
  assert.ok(matchIn02, 'in02 found');
  const in02Src = matchIn02[0].replace(/,\s*$/, '');
  const in02 = new Function('return (' + in02Src + ')')();

  const matchIn04 = html.match(/\{id:'in04',run:c=>[\s\S]*?\}\}\},/);
  assert.ok(matchIn04, 'in04 found');
  const in04Src = matchIn04[0].replace(/,\s*$/, '');
  const in04 = new Function('return (' + in04Src + ')')();

  const helper = {
    mny: n => '$' + n,
    sum: (a, f) => a.reduce((t, x) => t + (f(x) || 0), 0)
  };

  // (1) plain stock: 3 items, buyPrice 100 each, cashSpent 100 each, s.cash 300, s.cost 300
  const plainStock = [
    { buyPrice: 100, cashSpent: 100 },
    { buyPrice: 100, cashSpent: 100 },
    { buyPrice: 100, cashSpent: 100 }
  ];
  const res1 = in02.run({
    st: { stock: plainStock, cash: 300, cost: 300 },
    h: helper
  });
  assert.ok(res1 && res1.t.includes('$300'), 'in02 plain stock contains $300');

  // (2) trade stock: 3 items, buyPrice 200 each, cashSpent 50 each, s.cash 150, s.cost 600
  const tradeStock = [
    { buyPrice: 200, cashSpent: 50 },
    { buyPrice: 200, cashSpent: 50 },
    { buyPrice: 200, cashSpent: 50 }
  ];
  const res2 = in02.run({
    st: { stock: tradeStock, cash: 150, cost: 600 },
    h: helper
  });
  assert.ok(res2 && res2.t.includes('$150'), 'in02 trade stock contains $150');
  assert.ok(!res2.t.includes('$600'), 'in02 trade stock does not contain $600');

  // (3) in04 bucket tests
  const resTradeBucket = in04.run({
    st: {
      buckets: [
        { items: [] },
        { items: [] },
        { items: [] },
        {
          items: [
            { buyPrice: 200, cashSpent: 50 },
            { buyPrice: 200, cashSpent: 50 }
          ]
        }
      ]
    },
    h: helper
  });
  assert.ok(resTradeBucket && resTradeBucket.t.includes('tying up $100'), 'in04 trade items contains tying up $100');
  assert.ok(!resTradeBucket.t.includes('$400'), 'in04 trade items does not contain $400');

  const resPlainBucket = in04.run({
    st: {
      buckets: [
        { items: [] },
        { items: [] },
        { items: [] },
        {
          items: [
            { buyPrice: 100, cashSpent: 100 },
            { buyPrice: 100, cashSpent: 100 }
          ]
        }
      ]
    },
    h: helper
  });
  assert.ok(resPlainBucket && resPlainBucket.t.includes('tying up $200'), 'in04 plain items contains tying up $200');
});
