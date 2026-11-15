// Checks guest-link tracking in apps-script.gs: 2 h / 4 h links, several links at once, who is on right now, visit history and durations,
// "end all", and (most important) that tracking can never widen what a guest can do, never touch the sheet, never undo a revoke and never break a read.
// Google and the sheet are faked; no real data is involved.
import vm from 'node:vm';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';

const code = fs.readFileSync(new URL('../apps-script.gs', import.meta.url), 'utf8')
  .replace("'PASTE-YOUR-GOOGLE-CLIENT-ID.apps.googleusercontent.com'", "'client-1.apps.googleusercontent.com'")
  .replace("'you@example.com'", "'me@example.com'");

const TABS = () => ({
  Phones: { sheet: 'Master Inventory', headers: ['Model', 'Price'], rows: [{ Model: 'iPhone 13', Price: 500, _row: 2 }] },
  Expenses: { sheet: 'Expenses', headers: ['Item Purchased', 'Amount'], rows: [{ 'Item Purchased': 'Rent', Amount: 900, _row: 2 }] }
});

function make(opts = {}) {
  const props = {}, cache = {};
  let lockFree = true;
  const ctx = {
    console: { log() {} },
    ContentService: { MimeType: { JSON: 'JSON' }, createTextOutput: s => ({ text: s, setMimeType() { return this; } }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => { throw new Error('guest path must not touch the sheet directly'); } },
    LockService: { getScriptLock: () => ({ waitLock() {}, tryLock: () => { if (opts.lockThrows) throw new Error('lock boom'); return lockFree; }, releaseLock() {} }) },
    CacheService: { getScriptCache: () => ({
      get: k => { if (opts.cacheThrows) throw new Error('cache boom'); return k in cache ? cache[k] : null; },
      put: (k, v) => { if (opts.cacheThrows) throw new Error('cache boom'); cache[k] = v; },
      remove: k => { delete cache[k]; }
    }) },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: k => (k in props ? props[k] : null),
      setProperty: (k, v) => { if (opts.logThrows && k === 'mm.guestlog') throw new Error('props boom'); props[k] = v; }
    }) },
    UrlFetchApp: { fetch: () => { throw new Error('no network'); } },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (a, s) => Array.from(crypto.createHash('sha256').update(String(s), 'utf8').digest()).map(b => (b > 127 ? b - 256 : b)),
      formatDate: () => ''
    }
  };
  vm.createContext(ctx); vm.runInContext(code, ctx);
  ctx.__props = props; ctx.__cache = cache;
  ctx.__setLockFree = v => { lockFree = v; };
  ctx.readAll = () => TABS();
  ctx.__owner = ctx.newSession_().token;
  return ctx;
}
const post = (c, b) => JSON.parse(c.doPost({ postData: { contents: JSON.stringify(b) } }).text);
const own = (c, b) => post(c, { ...b, secret: c.__owner });
const mk = (c, minutes = 60, preset = 'business', label) => { const r = own(c, { action: 'guest_create', minutes, preset, label }); assert.equal(r.ok, true, JSON.stringify(r)); return r; };
const VID_A = 'a1b2c3d4e5f60718', VID_B = '0011223344556677';
const hello = (c, g, extra = {}) => post(c, { action: 'guest_ping', secret: g.key, vid: VID_A, dev: 'iPhone/iPad · Safari', ...extra });
const list = c => own(c, { action: 'guest_list' });

test('2 hour and 4 hour links can be made, and still nothing off the list', () => {
  const c = make();
  for (const m of [120, 240]) {
    const r = mk(c, m, 'all');
    assert.ok(Math.abs(r.exp - (Date.now() + m * 60000)) < 5000);
    own(c, { action: 'guest_revoke', id: r.id });
  }
  for (const m of [119, 121, 239, 241, 180]) assert.equal(own(c, { action: 'guest_create', minutes: m, preset: 'all' }).ok, false, String(m));
});

test('several links with different limits run side by side, each with its own label and end time', () => {
  const c = make();
  const a = mk(c, 120, 'sales', 'Mike'), b = mk(c, 240, 'business', 'Sara');
  const r = list(c);
  assert.equal(r.guests.length, 2);
  const byId = Object.fromEntries(r.guests.map(x => [x.id, x]));
  assert.equal(byId[a.id].label, 'Mike'); assert.equal(byId[b.id].label, 'Sara');
  assert.equal(byId[a.id].exp, a.exp); assert.equal(byId[b.id].exp, b.exp);
  assert.ok(byId[b.id].exp - byId[a.id].exp > 119 * 60000);
  // ending one leaves the other working
  own(c, { action: 'guest_revoke', id: a.id });
  assert.equal(post(c, { action: 'read', secret: a.key }).error, 'auth');
  assert.equal(post(c, { action: 'read', secret: b.key }).ok, true);
});

test('a hello shows the guest as on right now, per link, and starts the visit history', () => {
  const c = make();
  const a = mk(c, 120, 'sales', 'Mike'), b = mk(c, 240, 'business', 'Sara');
  const h = hello(c, a);
  assert.equal(h.ok, true); assert.equal(h.exp, a.exp);
  const r = list(c);
  const ga = r.guests.find(x => x.id === a.id), gb = r.guests.find(x => x.id === b.id);
  assert.equal(ga.live, 1); assert.equal(gb.live, 0);
  assert.equal(ga.visits, 1); assert.equal(gb.visits, 0);
  assert.equal(r.visits.length, 1);
  assert.equal(r.visits[0].id, a.id); assert.equal(r.visits[0].label, 'Mike'); assert.equal(r.visits[0].live, true);
  assert.equal(r.visits[0].dev, 'iPhone/iPad · Safari');
});

test('a plain read also counts as being there (so a blocked hello cannot hide a visit)', () => {
  const c = make();
  const g = mk(c);
  assert.equal(post(c, { action: 'read', secret: g.key }).ok, true);
  const r = list(c);
  assert.equal(r.guests[0].live, 1); assert.equal(r.guests[0].visits, 1);
});

test('two people on one link are counted separately; the same tab is counted once', () => {
  const c = make();
  const g = mk(c, 240, 'all', 'Team');
  hello(c, g, { vid: VID_A }); hello(c, g, { vid: VID_A }); hello(c, g, { vid: VID_B, dev: 'Windows · Chrome' });
  const r = list(c);
  assert.equal(r.guests[0].live, 2); assert.equal(r.guests[0].visits, 2);
  assert.deepEqual(r.visits.map(v => v.dev).sort(), ['Windows · Chrome', 'iPhone/iPad · Safari']);
});

test('someone who stopped saying hello is no longer "on right now", but the visit and its length stay', () => {
  const c = make();
  const g = mk(c, 240, 'all');
  hello(c, g);
  const key = Object.keys(c.__cache).find(k => k.startsWith('gv:'));
  const m = JSON.parse(c.__cache[key]);
  m[VID_A].s -= 20 * 60000; m[VID_A].e -= 10 * 60000;            // started 20 min ago, last seen 10 min ago
  c.__cache[key] = JSON.stringify(m);
  const r = list(c);
  assert.equal(r.guests[0].live, 0);
  assert.equal(r.visits[0].live, false);
  assert.ok(Math.abs(r.guests[0].seconds - 600) <= 2, String(r.guests[0].seconds));   // 10 minutes on the page
  assert.ok(Math.abs((r.visits[0].last - r.visits[0].start) - 600000) <= 2000);
});

test('coming back after a long quiet spell is a new visit', () => {
  const c = make();
  const g = mk(c, 10080, 'all');
  hello(c, g);
  const key = Object.keys(c.__cache).find(k => k.startsWith('gv:'));
  const m = JSON.parse(c.__cache[key]);
  m[VID_A].s -= 3 * 3600000; m[VID_A].e -= 2 * 3600000;
  c.__cache[key] = JSON.stringify(m);
  const lg = JSON.parse(c.__props['mm.guestlog']);                  // the saved history moves back in time too, like a real visit from hours ago
  lg.forEach(v => { v.s -= 3 * 3600000; v.e -= 2 * 3600000; });
  c.__props['mm.guestlog'] = JSON.stringify(lg);
  hello(c, g);
  const r = list(c);
  assert.equal(r.guests[0].visits, 2);
  assert.equal(r.guests[0].live, 1);
});

test('the history survives the live cache being cleared', () => {
  const c = make();
  const g = mk(c, 240, 'all', 'Mike');
  hello(c, g);
  assert.equal(JSON.parse(c.__props['mm.guestlog']).length, 1);   // written at the first hello
  for (const k of Object.keys(c.__cache)) delete c.__cache[k];
  const r = list(c);
  assert.equal(r.visits.length, 1); assert.equal(r.visits[0].label, 'Mike'); assert.equal(r.guests[0].live, 0);
});

test('a hello returns no sheet data, and a guest still can do nothing else', () => {
  const c = make();
  const g = mk(c, 60, 'all');
  const r = hello(c, g);
  assert.equal(r.ok, true); assert.equal(r.exp, g.exp);
  assert.deepEqual(Object.keys(r).sort(), ['exp', 'ok', 'status']);   // no tabs, no rows, no data: only "ok", the end time and the script's usual status word
  for (const action of ['edit', 'delete', 'undo', 'settings_get', 'settings_set', 'backfill', 'trade', 'add', 'check', 'logout', 'guest_create', 'guest_list', 'guest_revoke', 'guest_ping_x', 'bogus']) {
    const x = post(c, { action, secret: g.key, all: true, id: 'x', minutes: 60, preset: 'all', tab: 'Expenses' });
    assert.equal(x.ok, false, action); assert.equal(x.error, 'view-only', action);
  }
  assert.equal(list(c).guests.length, 1);   // the guest could not end or make links
});

test('a hello with no key, a wrong key, an ended link or an expired link is refused and records nothing', () => {
  const c = make();
  const g = mk(c, 60, 'all');
  assert.equal(post(c, { action: 'guest_ping' }).error, 'auth');
  assert.equal(post(c, { action: 'guest_ping', secret: 'nope', vid: VID_A }).error, 'auth');
  assert.equal(post(c, { action: 'guest_ping', secret: '', vid: VID_A }).error, 'auth');
  own(c, { action: 'guest_revoke', id: g.id });
  assert.equal(hello(c, g).error, 'auth');
  assert.equal(Object.keys(c.__cache).filter(k => k.startsWith('gv:')).length, 0);
  assert.equal(JSON.parse(c.__props['mm.guestlog'] || '[]').length, 0);   // no visit was recorded for any refused hello
  const g2 = mk(c, 30, 'all');
  const store = JSON.parse(c.__props['mm.guests']);
  for (const h of Object.keys(store)) store[h].exp = Date.now() - 1000;
  c.__props['mm.guests'] = JSON.stringify(store);
  const r = hello(c, g2);
  assert.equal(r.error, 'auth'); assert.equal(r.reason, 'guest-expired');
});

test('tracking never touches the sheet and never rewrites the guest list (so a visit cannot undo a revoke)', () => {
  const c = make();
  const a = mk(c, 60, 'all'), b = mk(c, 60, 'all');
  const before = c.__props['mm.guests'];
  hello(c, a); hello(c, b, { vid: VID_B });
  post(c, { action: 'read', secret: a.key });
  assert.equal(c.__props['mm.guests'], before);                    // byte-for-byte untouched by visits
  own(c, { action: 'guest_revoke', id: a.id });
  hello(c, b);                                                      // another guest keeps saying hello
  assert.equal(hello(c, a).error, 'auth');                          // the revoked one stays revoked
  assert.equal(list(c).guests.length, 1);
});

test('a revoked link drops out of "on now"; the history says it was ended early', () => {
  const c = make();
  const a = mk(c, 240, 'all', 'Mike');
  hello(c, a);
  assert.equal(list(c).guests[0].live, 1);
  own(c, { action: 'guest_revoke', id: a.id });
  const r = list(c);
  assert.equal(r.guests.length, 0);
  assert.equal(r.visits.length, 1); assert.equal(r.visits[0].live, false); assert.ok(r.visits[0].ended > 0);
});

test('"end all" cuts every viewer off, on every link, and nobody is "on now" afterwards', () => {
  const c = make();
  const a = mk(c, 120, 'sales', 'Mike'), b = mk(c, 240, 'business', 'Sara'), d = mk(c, 30, 'all');
  hello(c, a); hello(c, b, { vid: VID_B }); hello(c, d, { vid: '99aa99aa99aa99aa' });
  assert.equal(list(c).guests.reduce((n, x) => n + x.live, 0), 3);
  assert.equal(own(c, { action: 'guest_revoke', all: true }).revoked, 3);
  for (const g of [a, b, d]) { assert.equal(hello(c, g).error, 'auth'); assert.equal(post(c, { action: 'read', secret: g.key }).error, 'auth'); }
  const r = list(c);
  assert.equal(r.guests.length, 0);
  assert.ok(r.visits.length >= 3 && r.visits.every(v => !v.live && v.ended > 0));
  assert.equal(Object.keys(c.__cache).filter(k => k.startsWith('gv:')).length, 0);
});

test('the editor helper revokeAllGuests also clears the live picture', () => {
  const c = make();
  const a = mk(c, 120, 'all');
  hello(c, a);
  c.revokeAllGuests();
  assert.equal(hello(c, a).error, 'auth');
  assert.equal(list(c).guests.length, 0);
});

test('keys and hashes never appear in the list, the history, the cache or the log', () => {
  const c = make();
  const g = mk(c, 240, 'all', 'Mike');
  hello(c, g); post(c, { action: 'read', secret: g.key });
  const hash = crypto.createHash('sha256').update(g.key).digest('hex');
  // mm.guests is the one place the (hashed) key is kept, as before; everything the tracking adds must carry only the short id
  const tracking = JSON.stringify([list(c), c.__props['mm.guestlog'], Object.keys(c.__cache).filter(k => k.startsWith('gv:')).map(k => [k, c.__cache[k]])]);
  assert.ok(!tracking.includes(g.key));
  assert.ok(!tracking.includes(hash.slice(0, 40)));     // only the short 10-character id is ever shown or stored beside a visit
  assert.ok(tracking.includes(g.id));
});

test('odd tab ids and device names are cleaned: no markup, short, and an unknown id is grouped as one anonymous tab', () => {
  const c = make();
  const g = mk(c, 240, 'all');
  hello(c, g, { vid: '<script>alert(1)</script>', dev: '<img src=x onerror=alert(1)> ' + 'A'.repeat(200) });
  hello(c, g, { vid: 12345, dev: { a: 1 } });
  hello(c, g, { vid: undefined, dev: undefined });
  const r = list(c);
  assert.equal(r.guests[0].visits, 1);                              // all of those share the one "anon" tab
  for (const v of r.visits) { assert.ok(!/[<>=]/.test(v.dev)); assert.ok(v.dev.length <= 40); }
});

test('at most 30 tabs are tracked per link; more can still read', () => {
  const c = make();
  const g = mk(c, 240, 'all');
  for (let i = 0; i < 35; i++) assert.equal(hello(c, g, { vid: i.toString(16).padStart(16, '0') }).ok, true);
  assert.equal(post(c, { action: 'read', secret: g.key }).ok, true);
  const r = list(c);
  assert.equal(r.guests[0].live, 30);
});

test('the history is capped (60 visits, under the 9 KB property limit), newest kept', () => {
  const c = make();
  const g = mk(c, 10080, 'all', 'Mike');
  for (let i = 0; i < 90; i++) {
    hello(c, g, { vid: i.toString(16).padStart(16, '0'), dev: 'Windows · Chrome' });
    if (i % 25 === 24) list(c);                                      // flushes the live picture into the history now and then
  }
  list(c);
  const log = JSON.parse(c.__props['mm.guestlog']);
  assert.ok(log.length <= 60, String(log.length));
  assert.ok(c.__props['mm.guestlog'].length <= 8000, String(c.__props['mm.guestlog'].length));
});

test('if tracking itself breaks (cache, history or lock), guests can still read and the owner can still list and end links', () => {
  for (const opts of [{ cacheThrows: true }, { logThrows: true }, { lockThrows: true }]) {
    const c = make(opts);
    const g = mk(c, 60, 'sales');
    const r = post(c, { action: 'read', secret: g.key });
    assert.equal(r.ok, true, JSON.stringify(opts)); assert.equal(r.guest.preset, 'sales');
    assert.equal(hello(c, g).ok, true, JSON.stringify(opts));
    const l = list(c);
    assert.equal(l.ok, true, JSON.stringify(opts));
    assert.equal(own(c, { action: 'guest_revoke', id: g.id }).revoked, 1, JSON.stringify(opts));
    assert.equal(post(c, { action: 'read', secret: g.key }).error, 'auth');
  }
});

test('if the sheet is busy (lock not free) a hello is still answered and the live picture still works; the history catches up when it is free', () => {
  const c = make();
  const g = mk(c, 240, 'all');
  c.__setLockFree(false);
  assert.equal(hello(c, g).ok, true);
  assert.equal(c.__props['mm.guestlog'], undefined);                 // skipped, not blocked
  c.__setLockFree(true);
  assert.equal(list(c).guests[0].live, 1);
  assert.equal(JSON.parse(c.__props['mm.guestlog']).length, 1);      // the owner's list brings it up to date
});

test('a damaged history means an empty history, not an error', () => {
  const c = make();
  const g = mk(c, 60, 'all');
  for (const junk of ['not json', '{}', 'null', '"x"', '5', '[1,2,"x",null]']) {
    c.__props['mm.guestlog'] = junk;
    const r = list(c);
    assert.equal(r.ok, true, junk); assert.ok(Array.isArray(r.visits));
    assert.equal(post(c, { action: 'read', secret: g.key }).ok, true, junk);
  }
});

test('filtering is unchanged: tracking does not change what each preset shows', () => {
  const c = make();
  const g = mk(c, 60, 'business');
  hello(c, g);
  const r = post(c, { action: 'read', secret: g.key });
  assert.equal(r.tabs.Phones.rows.length, 1);
  assert.equal(r.tabs.Expenses.rows.length, 0);                      // business hides Expenses rows
  assert.equal(r.guest.preset, 'business');
  assert.deepEqual(Object.keys(r.guest).sort(), ['exp', 'preset']);  // the guest is never told its link id or label
});
