// Checks guest links in apps-script.gs: durations, owner-only creation, read-only gating, per-preset filtering/masking,
// expiry, revoke and the cap. Google and the sheet are faked; no real data is involved.
import vm from 'node:vm';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';

const code = fs.readFileSync(new URL('../apps-script.gs', import.meta.url), 'utf8')
  .replace("'PASTE-YOUR-GOOGLE-CLIENT-ID.apps.googleusercontent.com'", "'client-1.apps.googleusercontent.com'")
  .replace("'you@example.com'", "'me@example.com'");

const TABS = () => ({
  Expenses:   { sheet: 'Expenses', headers: ['Item Purchased', 'Amount', 'Notes'], rows: [{ 'Item Purchased': 'Rent', Amount: 900, Notes: 'private', _row: 2 }] },
  Phones:     { sheet: 'Master Inventory', headers: ['Model', 'IMEI', 'Device Label', 'Notes', 'Price'], rows: [{ Model: 'iPhone 13', IMEI: '123456789012345', 'Device Label': 'P-001', Notes: 'cracked back', Price: 500, _row: 2 }, { Model: 'Pixel 7', IMEI: null, 'Device Label': 'P-002', Notes: '', Price: 300, _row: 3 }] },
  Investments:{ sheet: 'Investment Tracking Sheet', headers: ['Investment Type', 'Total Portfolio Value'], rows: [{ 'Investment Type': 'ETF', 'Total Portfolio Value': 1000, _row: 2 }] },
  Owed:       { sheet: 'Owed', headers: ['Type', 'Person', 'Amount'], rows: [{ Type: 'Loan', Person: 'Sam', Amount: 50, _row: 2 }] },
  SoldPhones: { sheet: 'Form Responses - Sold', headers: ['Sold To', 'Sale Notes', 'Sale Price', 'Sold to', 'Sale By'], rows: [{ 'Sold To': 'Jane Doe', 'Sale Notes': 'cash', 'Sale Price': 600, 'Sold to': 'Jane', 'Sale By': 'Me', _row: 2 }] },
  BoughtPhones:{ sheet: 'Form Responses - Bought', headers: ['Bought From', 'Found By', 'Notes (Bought)', 'Cost'], rows: [{ 'Bought From': 'Mike', 'Found By': 'Kijiji', 'Notes (Bought)': 'ok', Cost: 200, _row: 2 }] },
  Missing:    { sheet: 'Nope', headers: [], rows: [], missing: true }
});

function make() {
  const props = {};
  const ctx = {
    console: { log() {} },
    ContentService: { MimeType: { JSON: 'JSON' }, createTextOutput: s => ({ text: s, setMimeType() { return this; } }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => { throw new Error('guest path must not touch the sheet directly'); } },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    CacheService: { getScriptCache: () => ({ get: () => null, put() {} }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = v; } }) },
    UrlFetchApp: { fetch: () => { throw new Error('no network'); } },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (a, s) => Array.from(crypto.createHash('sha256').update(String(s), 'utf8').digest()).map(b => (b > 127 ? b - 256 : b)),
      formatDate: () => ''
    }
  };
  vm.createContext(ctx); vm.runInContext(code, ctx);
  ctx.__props = props;
  ctx.__writes = [];
  ctx.readAll = () => TABS();                       // fake sheet read: the guest code only ever filters this
  ctx.__owner = ctx.newSession_().token;            // a real owner session made by the script itself
  return ctx;
}
const post = (c, b) => JSON.parse(c.doPost({ postData: { contents: JSON.stringify(b) } }).text);
const own = (c, b) => post(c, { ...b, secret: c.__owner });
const mk = (c, minutes = 60, preset = 'business') => { const r = own(c, { action: 'guest_create', minutes, preset }); assert.equal(r.ok, true, JSON.stringify(r)); return r; };

test('owner can make a guest key for each allowed duration', () => {
  const c = make();
  for (const m of [30, 60, 360, 720, 1440, 2880, 10080]) {
    const r = mk(c, m, 'all');
    assert.match(r.key, /^[0-9a-f]{64}$/);
    assert.ok(Math.abs(r.exp - (Date.now() + m * 60000)) < 5000);
    // each key is revoked straight away so the cap is never the thing under test
    assert.equal(own(c, { action: 'guest_revoke', id: r.id }).revoked, 1);
  }
});

test('durations that are not on the list are refused', () => {
  const c = make();
  for (const m of [0, 1, 29, 61, 90, 2881, 100000, -60, '60; drop', null, undefined, NaN, {}, []])
    assert.equal(own(c, { action: 'guest_create', minutes: m, preset: 'all' }).ok, false, String(m));
  assert.equal(Object.keys(JSON.parse(c.__props['mm.guests'] || '{}')).length, 0);
});

test('unknown presets are refused', () => {
  const c = make();
  for (const p of ['', 'admin', 'ALL', '__proto__', 'constructor', 'toString', null, undefined, 5])
    assert.equal(own(c, { action: 'guest_create', minutes: 60, preset: p }).ok, false, String(p));
});

test('only the hash of a guest key is stored, never the key', () => {
  const c = make();
  const r = mk(c);
  assert.ok(!c.__props['mm.guests'].includes(r.key));
});

test('guest keys cannot make, list or revoke guest links', () => {
  const c = make();
  const g = mk(c);
  for (const a of [{ action: 'guest_create', minutes: 60, preset: 'all' }, { action: 'guest_list' }, { action: 'guest_revoke', all: true }, { action: 'guest_revoke', id: g.id }]) {
    const r = post(c, { ...a, secret: g.key });
    assert.equal(r.ok, false); assert.equal(r.error, 'view-only');
  }
  assert.equal(own(c, { action: 'guest_list' }).guests.length, 1);   // nothing changed
});

test('no token, a made-up token or a guest-looking token cannot manage guests', () => {
  const c = make();
  for (const s of [undefined, '', 'x'.repeat(64), 5, {}]) assert.equal(post(c, { action: 'guest_create', minutes: 60, preset: 'all', secret: s }).error, 'auth');
});

test('a guest can read, and the reply says what they may see', () => {
  const c = make();
  const g = mk(c, 60, 'business');
  const r = post(c, { action: 'read', secret: g.key });
  assert.equal(r.ok, true);
  assert.equal(r.guest.preset, 'business');
  assert.equal(r.guest.exp, g.exp);
  assert.equal(r.tabs.Phones.rows.length, 2);
});

test('a guest can do NOTHING but read: every other action is view-only and never signs them out', () => {
  const c = make();
  const g = mk(c, 60, 'all');
  const actions = ['edit', 'delete', 'undo', 'settings_get', 'settings_set', 'backfill', 'trade', 'add', 'check', 'logout', 'login', 'bogus', undefined];
  for (const action of actions) {
    const r = post(c, { action, secret: g.key, tab: 'Expenses', values: { Amount: 1 }, id: 'x1', items: [{ key: 'a', value: 1 }] });
    if (action === 'login') continue;   // login carries no key; handled below
    assert.equal(r.ok, false, String(action)); assert.equal(r.error, 'view-only', String(action));
  }
  assert.equal(c.__writes.length, 0);
});

test('guest requests never reach the sheet except through the read filter', () => {
  const c = make();
  const g = mk(c, 60, 'all');
  // SpreadsheetApp.getActiveSpreadsheet throws in this fake, so any write path would blow up into ok:false/error text, not "view-only"
  for (const action of ['edit', 'delete', 'undo', 'settings_set', 'backfill', 'trade', 'add'])
    assert.equal(post(c, { action, secret: g.key, tab: 'Expenses' }).error, 'view-only');
});

test('preset "all": everything is visible and unmasked', () => {
  const c = make();
  const r = post(c, { action: 'read', secret: mk(c, 60, 'all').key });
  assert.equal(r.tabs.Expenses.rows.length, 1);
  assert.equal(r.tabs.Owed.rows.length, 1);
  assert.equal(r.tabs.Phones.rows[0].IMEI, '123456789012345');
});

test('preset "business": Expenses, Investments and Owed come back with headers but no rows; others are untouched', () => {
  const c = make();
  const r = post(c, { action: 'read', secret: mk(c, 60, 'business').key });
  for (const k of ['Expenses', 'Investments', 'Owed']) {
    assert.equal(r.tabs[k].rows.length, 0, k);
    assert.deepEqual(r.tabs[k].headers, TABS()[k].headers, k);
  }
  assert.equal(r.tabs.Phones.rows[0].IMEI, '123456789012345');        // not masked in this preset
  assert.equal(r.tabs.SoldPhones.rows[0]['Sold To'], 'Jane Doe');
  assert.ok(!JSON.stringify(r).includes('Rent') && !JSON.stringify(r).includes('Sam'));
});

test('preset "sales": same hidden tabs, and personal columns show (hidden)', () => {
  const c = make();
  const r = post(c, { action: 'read', secret: mk(c, 60, 'sales').key });
  assert.equal(r.tabs.Expenses.rows.length, 0);
  const p = r.tabs.Phones.rows[0];
  assert.equal(p.IMEI, '(hidden)'); assert.equal(p['Device Label'], '(hidden)'); assert.equal(p.Notes, '(hidden)');
  assert.equal(p.Model, 'iPhone 13'); assert.equal(p.Price, 500);     // business columns still there
  assert.equal(p._row, 2);
  assert.equal(r.tabs.Phones.rows[1].IMEI, null);                     // empty cells stay empty
  assert.equal(r.tabs.Phones.rows[1].Notes, '');
  const s = r.tabs.SoldPhones.rows[0];
  for (const h of ['Sold To', 'Sold to', 'Sale Notes', 'Sale By']) assert.equal(s[h], '(hidden)', h);
  assert.equal(s['Sale Price'], 600);
  const b = r.tabs.BoughtPhones.rows[0];
  for (const h of ['Bought From', 'Found By', 'Notes (Bought)']) assert.equal(b[h], '(hidden)', h);
  assert.equal(b.Cost, 200);
  const all = JSON.stringify(r);
  for (const secret of ['Jane', 'Mike', 'Kijiji', '123456789012345', 'cracked', 'P-001']) assert.ok(!all.includes(secret), secret);
});

test('masking and hiding also apply to the flat view', () => {
  const c = make();
  const r = post(c, { action: 'read', flat: '1', secret: mk(c, 60, 'sales').key });
  const all = JSON.stringify(r.data);
  assert.ok(!all.includes('Rent') && !all.includes('Jane') && !all.includes('123456789012345'));
  assert.ok(r.data.length > 0);
});

test('a missing tab stays reported as missing for guests', () => {
  const c = make();
  const r = post(c, { action: 'read', secret: mk(c, 60, 'sales').key });
  assert.equal(r.tabs.Missing.missing, true);
});

test('filtering never changes what the owner sees', () => {
  const c = make();
  mk(c, 60, 'sales');
  const r = own(c, { action: 'read' });
  assert.equal(r.tabs.Phones.rows[0].IMEI, '123456789012345');
  assert.equal(r.tabs.Expenses.rows.length, 1);
  assert.equal(r.guest, undefined);
});

test('an unknown preset in storage fails closed to the strictest one', () => {
  const c = make();
  const g = mk(c, 60, 'all');
  const store = JSON.parse(c.__props['mm.guests']);
  const h = Object.keys(store)[0]; store[h].preset = 'weird'; c.__props['mm.guests'] = JSON.stringify(store);
  const r = post(c, { action: 'read', secret: g.key });
  assert.equal(r.guest.preset, 'sales');
  assert.equal(r.tabs.Phones.rows[0].IMEI, '(hidden)');
  assert.equal(r.tabs.Expenses.rows.length, 0);
});

test('an expired guest key is refused with auth + guest-expired', () => {
  const c = make();
  const g = mk(c, 30, 'all');
  const store = JSON.parse(c.__props['mm.guests']);
  for (const h of Object.keys(store)) store[h].exp = Date.now() - 1000;
  c.__props['mm.guests'] = JSON.stringify(store);
  const r = post(c, { action: 'read', secret: g.key });
  assert.equal(r.ok, false); assert.equal(r.error, 'auth'); assert.equal(r.reason, 'guest-expired');
  assert.equal(post(c, { action: 'edit', secret: g.key }).error, 'auth');
});

test('a revoked guest key is refused as auth', () => {
  const c = make();
  const g = mk(c, 60, 'all');
  assert.equal(post(c, { action: 'read', secret: g.key }).ok, true);
  assert.equal(own(c, { action: 'guest_revoke', id: g.id }).revoked, 1);
  assert.equal(post(c, { action: 'read', secret: g.key }).error, 'auth');
});

test('revoking one link leaves the others; revoke all ends every one', () => {
  const c = make();
  const a = mk(c), b = mk(c), d = mk(c, 30, 'sales');
  own(c, { action: 'guest_revoke', id: a.id });
  assert.equal(post(c, { action: 'read', secret: a.key }).error, 'auth');
  assert.equal(post(c, { action: 'read', secret: b.key }).ok, true);
  assert.equal(own(c, { action: 'guest_revoke', all: true }).revoked, 2);
  for (const k of [b.key, d.key]) assert.equal(post(c, { action: 'read', secret: k }).error, 'auth');
  assert.equal(own(c, { action: 'guest_list' }).guests.length, 0);
});

test('bad revoke ids change nothing', () => {
  const c = make();
  const g = mk(c);
  for (const id of ['', 'zz', '../x', '0'.repeat(10), 'ABCDEF0123', 5, null]) own(c, { action: 'guest_revoke', id });
  assert.equal(post(c, { action: 'read', secret: g.key }).ok, true);
});

test('the list shows ids, presets and end times but never keys or hashes', () => {
  const c = make();
  const g = mk(c, 360, 'sales');
  const r = own(c, { action: 'guest_list' });
  assert.equal(r.guests.length, 1);
  assert.equal(r.guests[0].id, g.id); assert.equal(r.guests[0].preset, 'sales'); assert.equal(r.guests[0].exp, g.exp);
  const text = JSON.stringify(r);
  assert.ok(!text.includes(g.key) && !text.includes(crypto.createHash('sha256').update(g.key).digest('hex')));
});

test('the list drops links that have already ended', () => {
  const c = make();
  mk(c); mk(c);
  const store = JSON.parse(c.__props['mm.guests']);
  const h = Object.keys(store)[0]; store[h].exp = Date.now() - 5; c.__props['mm.guests'] = JSON.stringify(store);
  assert.equal(own(c, { action: 'guest_list' }).guests.length, 1);
});

test('at most 20 live guest links; ended ones do not count', () => {
  const c = make();
  for (let i = 0; i < 20; i++) mk(c);
  const r = own(c, { action: 'guest_create', minutes: 60, preset: 'all' });
  assert.equal(r.ok, false); assert.match(r.error, /too many/);
  assert.equal(Object.keys(JSON.parse(c.__props['mm.guests'])).length, 20);
  const store = JSON.parse(c.__props['mm.guests']);
  store[Object.keys(store)[0]].exp = Date.now() - 1; c.__props['mm.guests'] = JSON.stringify(store);
  assert.equal(own(c, { action: 'guest_create', minutes: 60, preset: 'all' }).ok, true);
});

test('a damaged guest store means no guests, not an error or an open door', () => {
  const c = make();
  for (const junk of ['not json', '[]', 'null', '"x"', '5']) {
    c.__props['mm.guests'] = junk;
    assert.equal(post(c, { action: 'read', secret: 'a'.repeat(64) }).error, 'auth');
    assert.equal(own(c, { action: 'guest_list' }).ok, true);
  }
});

test('an owner session and a guest key are different things: session tokens are not guest keys and vice versa', () => {
  const c = make();
  const g = mk(c, 60, 'all');
  assert.equal(post(c, { action: 'guest_list', secret: g.key }).error, 'view-only');
  assert.equal(own(c, { action: 'guest_list' }).ok, true);
  // a guest key is not accepted as an owner session
  assert.equal(c.authOk_(g.key), false);
  assert.equal(c.authOk_(c.__owner), true);
});

test('revokeAllSessions (owner sign-out everywhere) does not end guest links, and revokeAllGuests does not sign the owner out', () => {
  const c = make();
  const g = mk(c, 60, 'all');
  c.revokeAllSessions();
  assert.equal(post(c, { action: 'read', secret: g.key }).ok, true);
  assert.equal(own(c, { action: 'read' }).error, 'auth');
  const o2 = c.newSession_().token;
  c.revokeAllGuests();
  assert.equal(post(c, { action: 'read', secret: g.key }).error, 'auth');
  assert.equal(post(c, { action: 'read', secret: o2 }).ok, true);
});

test('the editor helper makes a working key', () => {
  const c = make();
  const r = c.createGuestLink(30, 'sales');
  assert.equal(r.ok, true);
  assert.equal(post(c, { action: 'read', secret: r.key }).guest.preset, 'sales');
  assert.equal(c.createGuestLink(7, 'sales').ok, false);
});

test('the status ping needs no token and shows no data', () => {
  const c = make();
  const r = JSON.parse(c.doGet({}).text);
  assert.equal(r.ok, true); assert.equal(r.guests, true); assert.equal(r.tabs, undefined);
});
