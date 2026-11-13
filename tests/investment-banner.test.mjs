// Run with: node --test tests/investment-banner.test.mjs
// Part 3, PR 1: the weekly investment contribution reminder rides inside the expiry banner.
// Loads the REAL "EXPIRY BANNER CORE" and "NOTIF-CORE" blocks out of index.html (no copies) and proves:
//  - the new option is on by default and old saved settings (without it) still work
//  - the item appears only when the banner is on, the option is on, and the reminder is due; it is added after deposits/loans
//  - snooze hides it; the old once-per-week dismissal still applies; deposits and loans are never reordered or lost
//  - screen-reader text is unchanged for deposits/loans and covers the reminder
//  - the old stand-alone card is kept as a fallback and never shown twice; nothing touches the sheet or the network
process.env.TZ = 'America/Toronto';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.html'), 'utf8');
const slice = (a, b) => { const i = html.indexOf(a), j = html.indexOf(b); assert.ok(i >= 0 && j > i, a + ' markers found'); return html.slice(i, j); };
const ebBlock = slice('/* ===== EXPIRY BANNER CORE START ===== */', '/* ===== EXPIRY BANNER CORE END ===== */');
const notifBlock = slice('/* NOTIF-CORE-START */', '/* NOTIF-CORE-END */');

const ctx = vm.createContext({ Date, Math, JSON, Object, Array, String, Number, parseInt, isNaN });
vm.runInContext(ebBlock + '\nthis.api={EB_DEFAULTS,ebNormalize,ebItems,ebWithInvest,ebInvestItem,ebPreviewItems,ebSampleItems,ebAnnounce,ebPatch,ebSnooze,ebDayKey};', ctx);
vm.runInContext(notifBlock + '\nthis.n={notifDue};', ctx);
const { ebNormalize, ebItems, ebWithInvest, ebPreviewItems, ebSampleItems, ebAnnounce, ebPatch, ebSnooze, ebDayKey } = ctx.api;
const { notifDue } = ctx.n;
const plain = x => JSON.parse(JSON.stringify(x));
const D = (y, m, d, h = 0, mi = 0) => new Date(y, m - 1, d, h, mi);
const today = D(2026, 11, 13, 9, 0);   // Friday
const cfg = o => Object.assign({ enabled: true, depDays: 3, loanDays: 3, invest: true }, o);
const dep = o => Object.assign({ id: 'D1', row: 3, name: 'Ali', device: 'Pixel 9', total: 500, paid: 100, balance: 400, pickup: D(2026, 11, 14), open: true }, o);
const owed = (deps, loans) => ({ hasOwed: true, deps: deps || [], loans: loans || [] });

test('option is on by default; old saved settings without it still work; bad values are cleaned', () => {
  assert.equal(ebNormalize(null).invest, true);
  assert.equal(ebNormalize({ enabled: true, position: 'top' }).invest, true, 'an older saved config has no invest value');
  assert.equal(ebNormalize({ invest: false }).invest, false);
  assert.equal(ebNormalize({ invest: 'false' }).invest, false);
  assert.equal(ebNormalize({ invest: 'junk' }).invest, true);
  assert.equal(ebPatch(null, 'invest', false).invest, false);
  assert.equal(ebPatch({ position: 'left' }, 'invest', false).position, 'left', 'other options are kept');
});

test('shows only when the banner is on, the option is on and the reminder is due', () => {
  assert.equal(plain(ebWithInvest([], cfg(), true, today, {})).length, 1);
  assert.equal(ebWithInvest([], cfg(), false, today, {}).length, 0, 'not due');
  assert.equal(ebWithInvest([], cfg(), 'yes', today, {}).length, 0, 'only a real true counts');
  assert.equal(ebWithInvest([], cfg({ invest: false }), true, today, {}).length, 0, 'option off');
  assert.equal(ebWithInvest([], cfg({ enabled: false }), true, today, {}).length, 0, 'banner off');
  assert.equal(ebWithInvest([], null, true, today, {}).length, 0, 'bad settings never throw');
});

test('visible even when there are no expiring deposits or loans', () => {
  const base = ebItems(owed([], []), cfg(), today, {});
  assert.equal(base.length, 0);
  const r = plain(ebWithInvest(base, cfg(), true, today, {}));
  assert.equal(r.length, 1);
  assert.equal(r[0].kind, 'inv');
  assert.equal(r[0].level, 'pending', 'yellow "open" look, same as other open items');
});

test('added after deposits and loans, which keep their order and are never dropped', () => {
  const base = plain(ebItems(owed([dep({ id: 'D1', pickup: D(2026, 11, 12) }), dep({ id: 'D2', pickup: D(2026, 11, 15) })]), cfg(), today, {}));
  assert.equal(base.length, 2);
  const r = plain(ebWithInvest(base, cfg(), true, today, {}));
  assert.deepEqual(r.slice(0, 2), base);
  assert.equal(r[2].kind, 'inv');
  assert.equal(base.length, 2, 'the input list is not changed');
});

test('never added twice', () => {
  const once = ebWithInvest([], cfg(), true, today, {});
  assert.equal(ebWithInvest(once, cfg(), true, today, {}).length, 1);
});

test('snooze hides it until the chosen day, then it returns', () => {
  const sn = ebSnooze({}, 'inv:weekly', today, 1);   // back tomorrow
  assert.equal(ebWithInvest([], cfg(), true, today, sn).length, 0);
  assert.equal(ebWithInvest([], cfg(), true, D(2026, 11, 13, 23, 59), sn).length, 0);
  assert.equal(ebWithInvest([], cfg(), true, D(2026, 11, 14, 0, 1), sn).length, 1);
  assert.equal(ebWithInvest([], cfg(), true, today, { 'inv:weekly': 'garbage' }).length, 1, 'a malformed snooze is ignored');
});

test('the old once-per-week dismissal still decides when it is due', () => {
  const n = { enabled: true, day: 4, time: '17:00' };   // Thursday 5 PM; Fri 13 Nov is in the week starting Mon 9 Nov
  assert.equal(notifDue(n, today, '', ''), true);
  assert.equal(notifDue(n, today, '', '2026-11-09'), false, 'dismissed this week');
  assert.equal(notifDue(n, D(2026, 11, 16, 9, 0), '', '2026-11-09'), false, 'next Monday is before Thursday');
  assert.equal(notifDue(n, D(2026, 11, 19, 18, 0), '', '2026-11-09'), true, 'back next week');
});

test('preview shows the reminder only when the option is on, and the sample list is unchanged', () => {
  assert.equal(plain(ebSampleItems()).length, 2, 'deposit/loan samples are exactly as before');
  assert.equal(ebPreviewItems(cfg()).length, 3);
  assert.equal(ebPreviewItems(cfg({ invest: false })).length, 2);
  assert.equal(plain(ebPreviewItems(cfg())).pop().key, 'preview:inv', 'preview never uses the real snooze key');
});

test('screen-reader text is unchanged for deposits and loans and covers the reminder', () => {
  assert.equal(ebAnnounce([{ level: 'overdue' }, { level: 'pending' }, { level: 'pending' }]), '3 deposit or loan deadlines: 1 overdue, 2 due soon.');
  assert.equal(ebAnnounce([{ kind: 'inv', level: 'pending' }]), 'Weekly investment contribution reminder.');
  assert.equal(ebAnnounce([{ kind: 'dep', level: 'overdue' }, { kind: 'inv', level: 'pending' }]), '1 deposit or loan deadline: 1 overdue. Also: weekly investment contribution reminder.');
  assert.equal(ebAnnounce([]), '');
});

test('wiring: banner is read-only, the old card is kept as a fallback and hidden only while the banner shows the reminder', () => {
  assert.ok(!/fetch|sheetCall|XMLHttpRequest|localStorage|sessionStorage|sendBeacon|document\.|window\.|LS\./.test(ebBlock), 'core still has no storage, network or page access');
  assert.ok(html.includes("id=\"eb-inv\""), 'settings switch exists under In-App');
  assert.ok(/'eb-inv':'invest'/.test(html), 'switch is wired to the invest option');
  assert.ok(html.includes('function notifShowBanner('), 'old stand-alone card code is still there (fallback)');
  assert.ok(/notifBannerHandles\(\)\)\{ const b=document\.getElementById\('notif-banner'\); if\(b&&!b\.dataset\.preview\) notifHideBanner\(\); return \}/.test(html), 'old card hides only while the banner handles it, and a preview of the old card is never hidden');
  assert.ok(/window\.__mmExpiryHandlesInvest=\(\)=>\{const c=load\(\); return c\.enabled&&c\.invest&&!!window\.__mmNotifApi\}/.test(html), 'banner claims the reminder only when it is on, the option is on and the reminder API exists');
  const ui = html.slice(html.indexOf('(()=>{try{\nconst K_CFG='), html.indexOf("window.__mmExpiryCheck=check;"));
  assert.ok(!/sheetCall|fetch\(|XMLHttpRequest|sendBeacon/.test(ui), 'banner UI never calls the network or writes to the sheet');
  assert.ok(/mm\.notif\.dismissed/.test(html) && /dismissWeek/.test(ui), 'Dismiss on the reminder reuses the weekly dismissal');
});
