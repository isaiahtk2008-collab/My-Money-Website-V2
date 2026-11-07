// My Money sheet connector v3: reads AND writes your sheet (adds rows; edits or deletes ONE row only after re-checking it; deletes only from Expenses and the Sold tabs).
// HOW TO INSTALL: open your Google Sheet > Extensions > Apps Script. Select ALL the old code, delete it, paste this,
// press Save. Then Deploy > Manage deployments > pencil icon > Version: New version > Deploy.
// Keep "Execute as: Me" and "Who has access: Anyone". The /exec link stays the same.
// The first time you deploy this version Google asks you to authorize it again (it now calls Google to check your sign-in). Click Allow.
// SIGN-IN: every request except the status ping must carry a session token. The website gets one by sending your Google sign-in to this
// script, which asks Google to verify it and only accepts GOOGLE_CLIENT_ID + ALLOWED_EMAIL below. No token = no data, no writes, no deletes.
// HOW TO CHECK IT: sign in on the website, then open Log > Sheet connection and press Test.

// Fill in both values below before you deploy. CLIENT_ID is the Web client ID from Google Cloud (it is not a secret).
const GOOGLE_CLIENT_ID = 'PASTE-YOUR-GOOGLE-CLIENT-ID.apps.googleusercontent.com';
const ALLOWED_EMAIL = 'you@example.com';
const SESSION_DAYS = 7;   // how long one sign-in stays valid
const MAX_SESSIONS = 8;   // newest sessions kept; older ones are signed out

// OPTIONAL break-glass word. Leave empty. If set, the same word typed into Log > Sheet connection is also accepted as a token.
// An empty value does NOT mean "open": with no valid token every request is refused.
const SECRET = '';

/* ---------- SIGN-IN AND SESSIONS ----------
   Tokens are random, shown to the website once, and only their SHA-256 hash is stored (Script properties, key mm.sessions).
   To sign every device out at once, run revokeAllSessions() from the Apps Script editor. */
const SESSIONS_KEY = 'mm.sessions';

function hex_(bytes) {
  return bytes.map(b => ((b < 0 ? b + 256 : b) + 256).toString(16).slice(1)).join('');
}
function sha256_(s) {
  return hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s), Utilities.Charset.UTF_8));
}
// Compares without stopping at the first difference.
function safeEq_(a, b) {
  a = String(a); b = String(b);
  let d = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
}
function loadSessions_() {
  try {
    const raw = PropertiesService.getScriptProperties().getProperty(SESSIONS_KEY);
    const o = raw ? JSON.parse(raw) : {};
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch (err) { return {}; }
}
function saveSessions_(o) {
  PropertiesService.getScriptProperties().setProperty(SESSIONS_KEY, JSON.stringify(o));
}
function newSession_() {
  const token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  const now = Date.now();
  const all = loadSessions_();
  Object.keys(all).forEach(h => { if (!(all[h] > now)) delete all[h]; });          // drop expired
  const mine = sha256_(token);
  const expires = now + SESSION_DAYS * 86400000;
  const others = Object.keys(all).filter(h => h !== mine).sort((a, b) => all[b] - all[a]);   // newest first
  const out = {};
  out[mine] = expires;                                                                        // the one just made is always kept
  others.slice(0, MAX_SESSIONS - 1).forEach(h => { out[h] = all[h]; });
  saveSessions_(out);
  return { token: token, expires: expires };
}
function sessionOk_(token) {
  if (!token) return false;
  const exp = loadSessions_()[sha256_(token)];
  return typeof exp === 'number' && exp > Date.now();
}
function endSession_(token) {
  const all = loadSessions_();
  delete all[sha256_(token)];
  saveSessions_(all);
}
function revokeAllSessions() { saveSessions_({}); }

// True only for a live session token (or the optional SECRET word). Everything except the status ping calls this first.
function authOk_(token) {
  token = typeof token === 'string' ? token : '';
  if (!token) return false;
  if (SECRET && safeEq_(token, SECRET)) return true;
  return sessionOk_(token);
}

// Asks Google whether this sign-in credential is real, for THIS app and THIS email. (Google calls this endpoint "for debugging";
// that is fine for one person signing in now and then. A busier app would check Google's public keys instead.)
function login_(credential) {
  // Every refusal says WHY in "reason" (a short code, never anything secret) so a failed sign-in can be fixed instead of guessed at.
  const no = why => ({ ok: false, error: 'auth', reason: String(why).slice(0, 90) });
  credential = String(credential || '');
  if (credential.length > 4096 || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(credential)) return no('shape');   // not even shaped like a sign-in token: do not bother Google
  let info;
  try {
    const res = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(credential), { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return no('google-http-' + res.getResponseCode());
    info = JSON.parse(res.getContentText());
  } catch (err) { return no('fetch: ' + String(err && err.message || err)); }
  if (!info || typeof info !== 'object') return no('google-reply');
  const iss = String(info.iss || '');
  const email = String(info.email || '').trim().toLowerCase();
  const exp = Number(info.exp) * 1000;
  if (iss !== 'accounts.google.com' && iss !== 'https://accounts.google.com') return no('issuer');
  if (info.aud !== GOOGLE_CLIENT_ID) return no('client-id-mismatch');
  if (String(info.email_verified) !== 'true') return no('email-not-verified');
  if (!email || email !== String(ALLOWED_EMAIL).trim().toLowerCase()) return no('email-mismatch');
  if (!(exp > Date.now())) return no('expired');
  const s = newSession_();
  return { ok: true, token: s.token, expires: s.expires };
}

// A cell that starts with = + - or @ would be turned into a formula by Google Sheets. Put a ' in front so it stays plain text.
// Real numbers (and number-looking text such as -12.50 or $5) are left alone so amounts still work.
function tx_(v) {
  if (typeof v !== 'string' || v === '') return v;
  if (!/^[=+\-@\t\r]/.test(v)) return v;
  if (/^[+-]?\s*\$?\s*(\d[\d,]*)?\.?\d+%?$/.test(v.trim())) return v;
  return "'" + v;
}

// WRITE: these are the ONLY tabs entries can be added to (matched ignoring case and spaces).
// Summary, Master Inventory, PCs, PnA and the other formula tabs are not listed, so they can never be touched.
const ALLOWED_TABS = ['Form Responses - Bought', 'Form Responses - PCs', 'Bought Access - Form', 'Form Responses - Sold', 'Form Responses - Sold PCs', 'Sold Access - Form', 'Expenses', 'Investment Tracking Sheet', 'Owed'];

// EDIT / DELETE: the ONLY tabs where an existing row can be changed or removed (matched ignoring case and spaces).
// Formula tabs (Master Inventory, PCs, PnA, Summary...) are not listed, so a row there can never be edited or deleted.
const EDITABLE_TABS = ['Expenses'];

// EDIT ONLY: the six entry tabs plus the Owed tab. An existing row can be EDITED here (every change is written to the "Edit Log" tab first). A row can be deleted only from the three Sold tabs (see SALE_DELETE_TABS), never from a Bought or Owed tab.
// Formula tabs (Master Inventory, PCs, PnA, Summary...) must never be added to this list or to EDITABLE_TABS.
const EDIT_ONLY_TABS = ['Form Responses - Bought', 'Form Responses - PCs', 'Bought Access - Form', 'Form Responses - Sold', 'Form Responses - Sold PCs', 'Sold Access - Form', 'Owed'];

// DELETE (sale rows): the only entry tabs a row can be deleted from (plus Expenses via EDITABLE_TABS).
// Bought tabs and formula tabs must never be added here. A sale row is logged in full to the "Edit Log" tab before it is removed.
const SALE_DELETE_TABS = ['Form Responses - Sold', 'Form Responses - Sold PCs', 'Sold Access - Form'];

// TRADE: the only tabs a `trade` request may write to (one Sold tab and one Bought tab per trade). Never Expenses or any formula tab.
const TRADE_SOLD_TABS = ['Form Responses - Sold', 'Form Responses - Sold PCs', 'Sold Access - Form'];
const TRADE_BOUGHT_TABS = ['Form Responses - Bought', 'Form Responses - PCs', 'Bought Access - Form'];

// The "Edit Log" tab is the ONLY tab this script may create. Each edited cell adds one row here (old value and new value).
const EDIT_LOG_TAB = 'Edit Log';
const EDIT_LOG_HEADERS = ['Timestamp', 'Tab', 'Row ID', 'Column', 'Old value', 'New value', 'Action'];

// READ: what the website loads. key = the site's name, tab = your tab, keys = columns that prove a row is real data.
// Reading never changes anything in the sheet.
const READ_TABS = {
  Expenses:    { tab: 'Expenses',                  keys: ['Item Purchased', 'Amount', 'Date of Purchase'] },
  Phones:      { tab: 'Master Inventory',          keys: ['Model', 'IMEI', 'Device Label'] },
  PCs:         { tab: 'PCs',                       keys: ['PC model', 'Device Label'] },
  Accessories: { tab: 'PnA',                       keys: ['Item ID', 'Model', 'Brand'] },
  Investments: { tab: 'Investment Tracking Sheet', keys: ['Investment Type', 'Date', 'Total Portfolio Value'] },
  // READ-ONLY entry tabs under new keys. The website does not use these yet. keys: [] means "every column counts as data".
  BoughtPhones: { tab: 'Form Responses - Bought',   keys: [] },
  BoughtPCs:    { tab: 'Form Responses - PCs',      keys: [] },
  BoughtAccess: { tab: 'Bought Access - Form',      keys: [] },
  SoldPhones:   { tab: 'Form Responses - Sold',     keys: [] },
  SoldPCs:      { tab: 'Form Responses - Sold PCs', keys: [] },
  SoldAccess:   { tab: 'Sold Access - Form',        keys: [] },
  // Owed (loans and deposits, told apart by its Type column): you create this tab by hand (the script never creates it). If it is missing it is reported as missing and the website simply skips it.
  Owed:         { tab: 'Owed',                      keys: [] }
};

// Every reply is JSON. `status` is added alongside the existing `ok` flag so older and newer callers both work.
function json(obj) {
  if (obj && typeof obj === 'object' && obj.status === undefined) obj.status = obj.ok ? 'success' : 'error';
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// Optional flat view for simple callers: every real row from every read tab as one array, each tagged with its tab key.
function flatten(tabs) {
  const data = [];
  Object.keys(tabs).forEach(key => { tabs[key].rows.forEach(row => data.push(Object.assign({ _tab: key }, row))); });
  return data;
}

function findSheet(ss, name) {
  const want = String(name).trim().toLowerCase();
  return ss.getSheets().find(s => s.getName().trim().toLowerCase() === want);
}

/* ---------- turn whatever is in a cell into the clean shape the website expects ---------- */
const pad2 = n => (n < 10 ? '0' : '') + n;

function makeDate(y, mo, d, h, mi, s) {
  y = +y; mo = +mo; d = +d; h = +(h || 0); mi = +(mi || 0); s = +(s || 0);
  if (y < 1900 || y > 2200 || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCMonth() !== mo - 1) return null; // e.g. Feb 31
  const day = y + '-' + pad2(mo) + '-' + pad2(d);
  return (h || mi || s) ? day + 'T' + pad2(h) + ':' + pad2(mi) + ':' + pad2(s) : day;
}

function to24(h, ap) {
  h = +h;
  if (!ap) return h;
  ap = ap.toLowerCase();
  if (ap === 'pm' && h < 12) return h + 12;
  if (ap === 'am' && h === 12) return 0;
  return h;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

// Text that is ONLY a date (or date and time). Anything else (like a note) is left alone.
function parseDateText(t) {
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?Z?)?$/);
  if (m) return makeDate(m[1], m[2], m[3], m[4], m[5], m[6]);
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:,?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?$/);
  if (m) {
    let a = +m[1], b = +m[2];
    if (a > 12 && b <= 12) { const x = a; a = b; b = x; } // 25/12/2026 style
    return makeDate(m[3], a, b, to24(m[4] || 0, m[7]), m[5], m[6]);
  }
  m = t.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m) {
    const mo = MONTHS[m[1].toLowerCase().slice(0, 3)];
    if (mo) return makeDate(m[3], mo, m[2]);
  }
  return null;
}

function cleanCell(v, tz) {
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return null;
    const day = Utilities.formatDate(v, tz, 'yyyy-MM-dd'), tm = Utilities.formatDate(v, tz, 'HH:mm:ss');
    if (day.indexOf('1899') === 0 || day.indexOf('1900') === 0) return tm;      // a time-only cell
    return tm === '00:00:00' ? day : day + 'T' + tm;
  }
  if (typeof v === 'number') return isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v;
  if (typeof v !== 'string') return null;
  const t = v.replace(/ /g, ' ').trim();
  if (t === '' || t === '-' || t === '—' || /^n\/?a$/i.test(t) || /^#(N\/A|REF!|VALUE!|DIV\/0!|NAME\?|NUM!|NULL!|ERROR!)/.test(t)) return null;
  const d = parseDateText(t);
  if (d) return d;
  let m = t.match(/^(-?)\s*\$\s*(-?)\s*(\d[\d,]*(?:\.\d+)?|\.\d+)$/);          // $1,000.00  -$5  $-325.00
  if (m) return (m[1] || m[2] ? -1 : 1) * parseFloat(m[3].replace(/,/g, ''));
  m = t.match(/^\(\s*\$?\s*(\d[\d,]*(?:\.\d+)?)\s*\)$/);                         // (12.50)
  if (m) return -parseFloat(m[1].replace(/,/g, ''));
  m = t.match(/^(-?\d+(?:\.\d+)?)\s*%$/);                                        // 12.5%  ->  0.125
  if (m) return parseFloat(m[1]) / 100;
  return t;
}

function readTab(ss, spec, tz) {
  const sheet = findSheet(ss, spec.tab);
  if (!sheet) return { sheet: spec.tab, headers: [], rows: [], missing: true };
  const lastRow = sheet.getLastRow(), lastCol = sheet.getLastColumn();
  if (lastRow < 1 || lastCol < 1) return { sheet: spec.tab, headers: [], rows: [] };
  const values = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  const headers = values[0].map(h => String(h).replace(/ /g, ' ').trim());
  const rows = [];
  for (let r = 1; r < values.length; r++) {
    const o = {};
    headers.forEach((h, i) => { if (h) o[h] = cleanCell(values[r][i], tz); });
    if (o._row === undefined) o._row = r + 1; // the row's number in the sheet (every header, "Row ID" included, is already a key above)
    rows.push(o);
  }
  // Formula tabs can stretch far below the real data. Drop rows at the very bottom that have none of the key columns.
  let keys = spec.keys.filter(k => headers.indexOf(k) >= 0);
  if (!keys.length) keys = headers.filter(Boolean);
  const real = row => keys.some(k => row[k] !== null && row[k] !== undefined);
  while (rows.length && !real(rows[rows.length - 1])) rows.pop();
  return { sheet: spec.tab, headers, rows };
}

function readAll() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const tz = ss.getSpreadsheetTimeZone();
  const tabs = {};
  Object.keys(READ_TABS).forEach(key => { tabs[key] = readTab(ss, READ_TABS[key], tz); });
  return tabs;
}

// Reports what it read and anything the website could not use. Shows a few example cells, never the whole sheet.
function checkAll() {
  const tabs = readAll(), out = {};
  const isDateCol = h => /date|timestamp/i.test(h), isMoneyCol = h => /amount|price|profit|portfolio value/i.test(h);
  Object.keys(tabs).forEach(key => {
    const t = tabs[key], problems = [];
    t.headers.filter(Boolean).forEach(h => {
      let bad = 0; const samples = [];
      t.rows.forEach((r, i) => {
        const v = r[h];
        if (v === null || v === undefined) return;
        const wrong = isDateCol(h) ? !(typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) : isMoneyCol(h) ? typeof v !== 'number' : false;
        if (wrong) { bad++; if (samples.length < 3) samples.push({ row: i + 2, value: v, type: typeof v }); }
      });
      if (bad) problems.push({ column: h, notUsable: bad, examples: samples });
    });
    out[key] = { tab: t.sheet, found: !t.missing, rows: t.rows.length, columns: t.headers.filter(Boolean).length, problems };
    // Report only (nothing is written): real data rows whose "Row ID" cell is empty. null when the tab has no "Row ID" column.
    const ridHeader = t.headers.find(h => normHeader(h) === 'rowid');
    let dataKeys = READ_TABS[key].keys.filter(k => t.headers.indexOf(k) >= 0);
    if (!dataKeys.length) dataKeys = t.headers.filter(h => h && h !== ridHeader);
    const filled = v => v !== null && v !== undefined;
    out[key].hasRowId = ridHeader !== undefined;
    out[key].missingRowId = ridHeader === undefined ? null : t.rows.filter(r => dataKeys.some(k => filled(r[k])) && !filled(r[ridHeader])).length;
  });
  return out;
}

/* ---------- SETTINGS SYNC (themes, appearance and the saved login record, shared by every device) ----------
   Uses ONE tab called "MM Settings". It is created only when the first setting is saved, and this code never reads, writes or
   changes any other tab. Each setting is one row: key, value (JSON text, so it can never turn into a formula), time changed.
   The newest change to each setting wins. The saved-login record is only stored when SECRET (top of this file) is set. */
const SETTINGS_TAB = 'MM Settings';
const SETTINGS_HEADER = ['Key', 'Value (JSON)', 'UpdatedAt (ms)', 'UpdatedAt (ISO)'];
const SETTINGS_ALLOWED = [
  'mm.theme', 'mm.privacy', 'mm.dense', 'mm.nav.order', 'mm.ss.prefs',   // not synced on purpose: the date-range filter and open/closed panels change constantly
  'mm.hfx.s', 'mm.hfx.dir', 'mm.hfx.col', 'mm.hfx.acc', 'mm.hfx.tile', 'mm.hfx.out', 'mm.hoverfx',
  'mm.hfx.round', 'mm.hfx.text', 'mm.hfx.enl', 'mm.hfx.bg', 'mm.hfx.anim', 'mm.hfx.amoled', 'mm.hfx.ink',
  'mm.clr.accent', 'mm.clr.glow', 'mm.clr.outline', 'mm.clr.tile.dark', 'mm.clr.tile.light',
  'mm.fold.corner', 'mm.fold.on', 'mm.notif', 'mm.auth.cred'
];
const SETTINGS_NEEDS_SECRET = ['mm.auth.cred']; // the salted login hash is only kept/returned when SECRET is not empty
const SETTINGS_MAX_ITEMS = 40;
const SETTINGS_MAX_LEN = 2000;

function settingsKeyOk_(k) {
  if (SETTINGS_ALLOWED.indexOf(k) < 0) return false;
  if (SETTINGS_NEEDS_SECRET.indexOf(k) >= 0 && !SECRET) return false;
  return true;
}

// Returns the settings tab. create=false never creates it (undefined if missing). null = a tab with that name exists but is not ours.
function settingsSheet_(ss, create) {
  let sh = ss.getSheetByName(SETTINGS_TAB);
  if (!sh) {
    if (!create) return undefined;
    sh = ss.insertSheet(SETTINGS_TAB, ss.getNumSheets());
    sh.getRange(1, 1, 1, SETTINGS_HEADER.length).setValues([SETTINGS_HEADER]);
    sh.getRange('B:B').setNumberFormat('@');
    sh.setFrozenRows(1);
    return sh;
  }
  const have = sh.getRange(1, 1, 1, SETTINGS_HEADER.length).getValues()[0];
  for (let i = 0; i < SETTINGS_HEADER.length; i++) if (String(have[i]) !== SETTINGS_HEADER[i]) return null;
  return sh;
}

// { key: { v: string|null, t: ms } } for allowed keys only. Never creates the tab.
function readSettings_(ss) {
  const out = {};
  const sh = settingsSheet_(ss, false);
  if (!sh) return out;
  const n = sh.getLastRow() - 1;
  if (n < 1) return out;
  sh.getRange(2, 1, n, 3).getValues().forEach(function (r) {
    const k = String(r[0]);
    if (!settingsKeyOk_(k)) return;
    const t = Number(r[2]);
    if (!isFinite(t) || t <= 0) return;
    let v;
    try { v = JSON.parse(String(r[1])); } catch (e) { return; }
    if (v !== null && typeof v !== 'string') return;
    out[k] = { v: v, t: t };
  });
  return out;
}

// items: [{k, v, t}] with v a string or null (null = setting removed). Newest t wins. The script lock is already held by doPost.
function writeSettings_(ss, items) {
  const sh = settingsSheet_(ss, true);
  if (!sh) return { ok: false, error: 'settings tab conflict' };
  const rowOf = {}, tOf = {};
  const last = sh.getLastRow();
  if (last > 1) {
    sh.getRange(2, 1, last - 1, 3).getValues().forEach(function (r, i) {
      const k = String(r[0]);
      if (!(k in rowOf)) { rowOf[k] = i + 2; tOf[k] = Number(r[2]) || 0; }
    });
  }
  const now = Date.now();
  const applied = [], skipped = [], pending = {}, order = [];
  items.slice(0, SETTINGS_MAX_ITEMS).forEach(function (it) {
    const k = it && it.k;
    const skip = function (why) { skipped.push({ k: typeof k === 'string' ? k : null, reason: why }); };
    if (typeof k !== 'string' || SETTINGS_ALLOWED.indexOf(k) < 0) return skip('key not allowed');
    if (SETTINGS_NEEDS_SECRET.indexOf(k) >= 0 && !SECRET) return skip('secret required');
    if (!(it.v === null || typeof it.v === 'string')) return skip('bad value');
    if (typeof it.v === 'string' && it.v.length > SETTINGS_MAX_LEN) return skip('too long');
    const t = it.t;
    if (typeof t !== 'number' || !isFinite(t) || Math.floor(t) !== t || t <= 0) return skip('bad time');
    if (t > now + 10 * 60 * 1000) return skip('time in future');
    if (t <= (k in tOf ? tOf[k] : 0)) return skip('older');
    tOf[k] = t;
    if (!(k in pending)) { order.push(k); applied.push(k); }
    pending[k] = [k, JSON.stringify(it.v), t, new Date(t).toISOString()];
  });
  const fresh = [];
  order.forEach(function (k) {
    if (k in rowOf) sh.getRange(rowOf[k], 1, 1, 4).setValues([pending[k]]);
    else fresh.push(pending[k]);
  });
  if (fresh.length) sh.getRange(sh.getLastRow() + 1, 1, fresh.length, 4).setValues(fresh);
  return { ok: true, applied: applied, skipped: skipped, settings: readSettings_(ss) };
}

// A plain GET only ever answers the harmless status ping below. It never returns sheet data and never needs a token, so it
// cannot leak anything. Reading, checking and settings are POST requests that must carry a valid token (see doPost).
function doGet(e) {
  return json({ ok: true, service: 'my-money-entry', version: 3, read: true, edit: true, backfill: true, trade: true, settings: true, settingsSecret: !!SECRET, auth: 'session' });
}

// The read-type answers. Only doPost calls this, and only after authOk_ passed.
function readReply_(body) {
  try {
    if (body.action === 'settings_get') {
      return { ok: true, version: 3, secretSet: !!SECRET, settings: readSettings_(SpreadsheetApp.getActiveSpreadsheet()) };
    }
    if (body.action === 'check') return { ok: true, version: 3, at: new Date().toISOString(), tabs: checkAll() };
    const tabs = readAll();
    const reply = { ok: true, version: 3, at: new Date().toISOString(), tabs: tabs };
    if (body.flat === '1' || body.flat === 1 || body.flat === true) reply.data = flatten(tabs); // action "read" with flat -> { status: "success", data: [...] }
    return reply;
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/* ---------- writing (unchanged behaviour: only ever ADDS a row, never overwrites) ---------- */
function seenId(id) {
  if (!id) return false;
  const cache = CacheService.getScriptCache();
  if (cache.get('id:' + id)) return true;
  try {
    const map = JSON.parse(PropertiesService.getScriptProperties().getProperty('SEEN_IDS') || '{}');
    if (map[id]) { cache.put('id:' + id, '1', 21600); return true; }
  } catch (e) {}
  return false;
}

function markId(id) {
  if (!id) return;
  CacheService.getScriptCache().put('id:' + id, '1', 21600);
  const props = PropertiesService.getScriptProperties();
  let map = {};
  try { map = JSON.parse(props.getProperty('SEEN_IDS') || '{}') || {}; } catch (e) {}
  const now = Date.now();
  map[id] = now;
  let entries = Object.keys(map).map(k => [k, map[k]]).filter(p => p[1] >= now - 30 * 86400000);
  if (entries.length > 200) { entries.sort((a, b) => b[1] - a[1]); entries = entries.slice(0, 200); }
  const out = {};
  entries.forEach(p => { out[p[0]] = p[1]; });
  props.setProperty('SEEN_IDS', JSON.stringify(out));
}

/* ---------- TRADE: one sold row + one received-device row as ONE request, all or nothing ----------
   planAddRow follows exactly the same rules as the plain add in doPost (header match, next free row, optional Row ID, never overwrite)
   but only READS. addTrade plans both rows first, writes only if both are safe, undoes its own writes if anything fails midway,
   and remembers the id only after both rows landed, so a retry of the same id can never add a second pair. */
function planAddRow(ss, tabName, inVals) {
  const sheet = findSheet(ss, tabName);
  if (!sheet) return { ok: false, error: 'no tab: ' + tabName };

  const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn() || 1).getValues()[0].map(norm);
  const inputVals = inVals || {};
  const matchedCols = {}, matchedKeys = new Set();

  headers.forEach((h, idx) => {
    if (h === 'timestamp') {
      matchedCols[idx + 1] = new Date();
    } else if (h) {
      const k = Object.keys(inputVals).find(key => norm(key) === h);
      if (k !== undefined) {
        matchedKeys.add(k);
        let v = inputVals[k];
        if (v && typeof v === 'object' && v.$date) {
          const [y, m, d] = v.$date.split('-').map(Number);
          v = new Date(y, m - 1, d);
        }
        matchedCols[idx + 1] = v;
      }
    }
  });
  const unmatched = Object.keys(inputVals).filter(k => !matchedKeys.has(k));

  const cols = Object.keys(matchedCols).map(Number);
  let targetRow = 2;
  const maxRows = sheet.getMaxRows();
  if (maxRows > 1 && cols.length > 0) {
    const data = sheet.getRange(2, 1, maxRows - 1, sheet.getLastColumn()).getValues();
    for (let r = data.length - 1; r >= 0; r--) {
      if (cols.some(c => data[r][c - 1] !== '')) {
        targetRow = r + 3;
        break;
      }
    }
  }

  const ridCol = headers.indexOf('rowid') + 1;
  let rowId;
  if (ridCol > 0 && cols.length > 0) {
    const given = matchedCols[ridCol];
    if (given === undefined || given === null || String(given).trim() === '') {
      rowId = makeRowId();
      matchedCols[ridCol] = rowId;
      if (cols.indexOf(ridCol) < 0) cols.push(ridCol);
    } else {
      rowId = String(given);
    }
  }

  if (targetRow <= maxRows) {
    const clash = cols.some(c => { const cell = sheet.getRange(targetRow, c); return cell.getFormula() !== '' || cell.getValue() !== ''; });
    if (clash) return { ok: false, error: 'target row not empty' };
  }

  return { ok: true, sheet: sheet, targetRow: targetRow, maxRows: maxRows, cols: cols, matchedCols: matchedCols, rowId: rowId, unmatched: unmatched };
}

function addTrade(ss, body) {
  const id = body && body.id;
  if (typeof id !== 'string' || !id.trim()) return { ok: false, error: 'trade needs an id' };

  // Ignore retries of a trade that already landed
  if (seenId(id)) return { ok: true, dup: true };

  const soldTabStr = String((body && body.soldTab) || '').trim().toLowerCase();
  if (!TRADE_SOLD_TABS.some(t => t.toLowerCase() === soldTabStr)) return { ok: false, error: 'tab not allowed: ' + body.soldTab };
  const boughtTabStr = String((body && body.boughtTab) || '').trim().toLowerCase();
  if (!TRADE_BOUGHT_TABS.some(t => t.toLowerCase() === boughtTabStr)) return { ok: false, error: 'tab not allowed: ' + body.boughtTab };

  const isObjectWithKeys = obj => obj && typeof obj === 'object' && !Array.isArray(obj) && Object.keys(obj).length > 0;
  if (!isObjectWithKeys(body.soldValues) || !isObjectWithKeys(body.boughtValues)) return { ok: false, error: 'trade needs soldValues and boughtValues' };

  // Plan BOTH rows before writing anything (reads only).
  const soldPlan = planAddRow(ss, body.soldTab, body.soldValues);
  if (!soldPlan.ok) return { ok: false, error: soldPlan.error, which: 'sold' };
  const boughtPlan = planAddRow(ss, body.boughtTab, body.boughtValues);
  if (!boughtPlan.ok) return { ok: false, error: boughtPlan.error, which: 'bought' };

  // Write sold, then bought. If anything throws, put back every cell we wrote (each was verified empty, so '' restores it exactly).
  const written = [];
  try {
    const plans = [soldPlan, boughtPlan];
    for (let i = 0; i < plans.length; i++) {
      const p = plans[i];
      if (p.targetRow > p.maxRows) p.sheet.insertRowsAfter(p.maxRows, p.targetRow - p.maxRows);
      for (let j = 0; j < p.cols.length; j++) {
        const c = p.cols[j];
        p.sheet.getRange(p.targetRow, c).setValue(tx_(p.matchedCols[c]));
        written.push([p.sheet, p.targetRow, c]);
      }
    }
  } catch (err) {
    let rolledBack = true;
    for (let k = written.length - 1; k >= 0; k--) {
      try { written[k][0].getRange(written[k][1], written[k][2]).setValue(''); } catch (rbErr) { rolledBack = false; }
    }
    if (rolledBack) return { ok: false, error: 'trade write failed, nothing was kept: ' + String(err), rolledBack: true };
    markId(id); // the undo failed too: remember the id so a retry can never add a second pair
    return { ok: false, error: 'trade partly written, check the Sold and Bought tabs: ' + String(err) + '. Do not retry: this trade will not be added again.', partial: true };
  }

  markId(id);
  const res = { ok: true, trade: true, id: id, soldRow: soldPlan.targetRow, boughtRow: boughtPlan.targetRow, unmatchedSold: soldPlan.unmatched, unmatchedBought: boughtPlan.unmatched };
  if (soldPlan.rowId !== undefined) res.soldRowId = soldPlan.rowId;
  if (boughtPlan.rowId !== undefined) res.boughtRowId = boughtPlan.rowId;
  return res;
}

/* ---------- editing and deleting ONE existing row (new requests use `target` and `changes`, never `tab` and `values`,
   so an older copy of this script can only reject them, never mistake them for a new entry) ---------- */
const normHeader = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

// Is the cell the website saw still what the sheet holds right now?
function sameCell(live, want) {
  const blank = v => v === null || v === undefined || String(v).trim() === '';
  if (blank(live) || blank(want)) return blank(live) && blank(want);
  const iso = /^\d{4}-\d{2}-\d{2}/;
  if (typeof live === 'string' && iso.test(live) && iso.test(String(want))) return live.slice(0, 10) === String(want).slice(0, 10);
  if (typeof live === 'number') { const n = parseFloat(String(want).replace(/[$,]/g, '')); return !isNaN(n) && Math.abs(n - live) < 0.005; }
  return String(live).trim().toLowerCase() === String(want).trim().toLowerCase();
}

// Finds the one row the website means and proves it is still the same row. Any doubt = refuse, change nothing.
// A request may carry `rowId`. Then the row is found by its "Row ID" cell (exactly one match, otherwise refuse) and the `row` number is ignored,
// so rows deleted above it cannot shift the target. The `expect` check below STILL runs on that row, as a second lock.
// Without `rowId` nothing is different: the `row` number plus `expect`, exactly as before.
function lockRow(ss, body, allowEditOnly, allowSaleDelete) {
  const reqTab = String(body.target || '').trim().toLowerCase();
  // allowEditOnly adds EDIT_ONLY_TABS. Only editRow passes it. allowSaleDelete adds SALE_DELETE_TABS. Only deleteRow passes it.
  // Bought tabs are therefore never allowed for delete (they are in EDIT_ONLY_TABS but not in SALE_DELETE_TABS).
  let allowed = EDITABLE_TABS;
  if (allowEditOnly === true) allowed = allowed.concat(EDIT_ONLY_TABS);
  if (allowSaleDelete === true) allowed = allowed.concat(SALE_DELETE_TABS);
  if (!allowed.some(t => t.toLowerCase() === reqTab)) return { error: 'tab not allowed: ' + body.target };
  const sheet = findSheet(ss, reqTab);
  if (!sheet) return { error: 'no tab: ' + body.target };
  const byId = body.rowId !== undefined && body.rowId !== null;
  let row;
  if (!byId) {
    row = Number(body.row);
    if (!Number.isInteger(row) || row < 2 || row > sheet.getLastRow()) return { error: 'bad row' };
  }
  const expect = body.expect && typeof body.expect === 'object' ? body.expect : {};
  const keys = Object.keys(expect);
  if (keys.length < 2) return { error: 'expect needs at least 2 columns' };
  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(normHeader);
  if (byId) {
    const id = typeof body.rowId === 'string' || typeof body.rowId === 'number' ? String(body.rowId).trim() : '';
    if (id === '') return { error: 'bad row id' };
    if (headers.filter(h => h === 'rowid').length !== 1) return { error: 'tab needs exactly one Row ID column' };
    const ridIdx = headers.indexOf('rowid'), lastRow = sheet.getLastRow();
    const ids = lastRow >= 2 ? sheet.getRange(2, ridIdx + 1, lastRow - 1, 1).getValues() : [];
    const hits = [];
    ids.forEach((cell, i) => { if (String(cell[0]).trim() === id) hits.push(i + 2); });
    if (hits.length === 0) return { error: 'row id not found' };
    if (hits.length > 1) return { error: 'row id not unique' };
    row = hits[0];
  }
  const live = sheet.getRange(row, 1, 1, lastCol).getValues()[0];
  const tz = ss.getSpreadsheetTimeZone();
  const changed = keys.some(k => { const c = headers.indexOf(normHeader(k)); return c < 0 || !sameCell(cleanCell(live[c], tz), expect[k]); });
  if (changed) return { error: 'row changed' };
  return { sheet, row, headers, lastCol };
}

// Finds the "Edit Log" tab, or creates it (with its header row) if it does not exist. This is the ONLY tab the script may create.
// An existing Edit Log is never changed here; headers are written only into a brand-new or completely empty one.
function ensureEditLog(ss) {
  let sheet = findSheet(ss, EDIT_LOG_TAB);
  if (!sheet) sheet = ss.insertSheet(EDIT_LOG_TAB);
  if (sheet.getLastRow() === 0) sheet.getRange(1, 1, 1, EDIT_LOG_HEADERS.length).setValues([EDIT_LOG_HEADERS]);
  return sheet;
}

// Writes only the named cells of that one row. Formula cells and the Timestamp are never touched.
// Before each cell is written, one row (old value, new value) is added to the Edit Log. If that cannot be done, the cell is NOT written.
function editRow(ss, body) {
  const g = lockRow(ss, body, true);
  if (g.error) return { ok: false, error: g.error };
  let logSheet;
  try { logSheet = ensureEditLog(ss); } catch (logErr) { return { ok: false, error: 'edit log unavailable' }; }
  const rawHeaders = g.sheet.getRange(1, 1, 1, g.lastCol).getValues()[0];
  const ridCols = g.headers.map((h, i) => (h === 'rowid' ? i + 1 : 0)).filter(Boolean);
  const rowIdValue = ridCols.length === 1 ? g.sheet.getRange(g.row, ridCols[0]).getValue() : g.row;
  const changes = body.changes && typeof body.changes === 'object' ? body.changes : {};
  const updated = [], skipped = [];
  const names = Object.keys(changes);
  for (let n = 0; n < names.length; n++) {
    const k = names[n];
    const c = g.headers.indexOf(normHeader(k));
    if (c < 0 || normHeader(k) === 'timestamp') { skipped.push(k); continue; }
    const cell = g.sheet.getRange(g.row, c + 1);
    if (cell.getFormula() !== '') { skipped.push(k); continue; }
    let v = changes[k];
    if (v && typeof v === 'object' && v.$date) { const [y, m, d] = String(v.$date).split('-').map(Number); v = new Date(y, m - 1, d); }
    if (v !== null && typeof v === 'object' && !(v instanceof Date)) { skipped.push(k); continue; }
    const newValue = v === null ? '' : v;
    try {
      logSheet.appendRow([new Date(), g.sheet.getName(), rowIdValue, rawHeaders[c] || k, tx_(cell.getValue()), tx_(newValue), 'edit']);
    } catch (logErr) {
      return { ok: false, error: 'edit log write failed', row: g.row, updated, skipped };
    }
    cell.setValue(tx_(newValue));
    updated.push(k);
  }
  return { ok: true, row: g.row, updated, skipped };
}

// Removes exactly that one row, and only if it holds no formulas.
// Allowed tabs: Expenses, and the three Sold tabs (SALE_DELETE_TABS). Never passes allowEditOnly to lockRow, so the three Bought tabs can never have a row deleted.
// Expenses: deleted as before (no log row). A Sold tab row is also refused if it has a Trade ID (trade sales are fixed by editing or by hand),
// and its full old row is written to the Edit Log (Action 'delete') BEFORE it is removed. If the log cannot be written, nothing is deleted.
function deleteRow(ss, body) {
  const g = lockRow(ss, body, false, true);
  if (g.error) return { ok: false, error: g.error };
  for (let c = 1; c <= g.lastCol; c++) if (g.sheet.getRange(g.row, c).getFormula() !== '') return { ok: false, error: 'row has formulas' };

  const isSale = SALE_DELETE_TABS.some(t => t.toLowerCase() === String(g.sheet.getName()).trim().toLowerCase());
  if (!isSale) {
    g.sheet.deleteRow(g.row);
    return { ok: true, row: g.row, deleted: true };
  }

  // Sale row: exactly one Trade ID column, and this row's Trade ID must be empty.
  const tradeCols = g.headers.map((h, i) => (h === 'tradeid' ? i + 1 : 0)).filter(Boolean);
  if (tradeCols.length !== 1) return { ok: false, error: 'tab needs exactly one Trade ID column' };
  if (String(g.sheet.getRange(g.row, tradeCols[0]).getValue()).trim() !== '') return { ok: false, error: 'trade sale: edit it or fix it by hand' };

  let logSheet;
  try { logSheet = ensureEditLog(ss); } catch (logErr) { return { ok: false, error: 'edit log unavailable' }; }

  // The full old row as {header: value}, so it can be re-created by hand.
  const rawHeaders = g.sheet.getRange(1, 1, 1, g.lastCol).getValues()[0];
  const values = g.sheet.getRange(g.row, 1, 1, g.lastCol).getValues()[0];
  const old = {};
  for (let i = 0; i < g.lastCol; i++) {
    let key = String(rawHeaders[i] || '').trim() || 'col ' + (i + 1);
    if (Object.prototype.hasOwnProperty.call(old, key)) key = key + ' (col ' + (i + 1) + ')';
    old[key] = values[i];
  }
  const ridCols = g.headers.map((h, i) => (h === 'rowid' ? i + 1 : 0)).filter(Boolean);
  const rowIdValue = ridCols.length === 1 ? g.sheet.getRange(g.row, ridCols[0]).getValue() : g.row;

  try {
    logSheet.appendRow([new Date(), g.sheet.getName(), rowIdValue, 'ALL COLUMNS (row deleted)', JSON.stringify(old), '', 'delete']);
  } catch (logErr) {
    return { ok: false, error: 'edit log write failed' };
  }
  g.sheet.deleteRow(g.row);
  return { ok: true, row: g.row, deleted: true };
}

// UNDO. Restores the most recent Edit Log change that has not been undone yet. Nothing in the Edit Log is ever changed or removed: an undo is
// recorded by appending a row with Action 'undo', and each 'undo' row cancels the nearest earlier 'edit' row (so an edit can never be undone twice).
// The cell is restored only if it STILL holds the logged new value. Only EDITABLE_TABS / EDIT_ONLY_TABS; never formula cells, Timestamp or Row ID.
// Optional `logRow` (the Edit Log row the caller means) makes a retry safe: if that row is no longer the latest undoable one, nothing is changed.
function undoRow(ss, body) {
  const logSheet = findSheet(ss, EDIT_LOG_TAB);
  if (!logSheet || logSheet.getLastRow() < 2) return { ok: false, error: 'nothing to undo' };

  const lastRow = logSheet.getLastRow();
  const rows = logSheet.getRange(2, 1, lastRow - 1, 7).getValues();

  let target = null;
  let logRow = -1;
  let pending = 0;

  for (let i = rows.length - 1; i >= 0; i--) {
    const action = String(rows[i][6] || '').trim();
    if (action === 'undo') {
      pending++;
    } else if (action === 'edit') {
      if (pending > 0) {
        pending--;
      } else {
        target = rows[i];
        logRow = i + 2;
        break;
      }
    }
  }

  if (!target) return { ok: false, error: 'nothing to undo' };
  if (body && body.logRow !== undefined && Number(body.logRow) !== logRow) {
    return { ok: false, error: 'log row changed' };
  }

  const loggedTab = String(target[1] || '').trim();
  const loggedRowId = String(target[2] === null || target[2] === undefined ? '' : target[2]).trim();
  const loggedColumn = target[3];
  const loggedOld = target[4];
  const loggedNew = target[5];

  const allowedTabs = EDITABLE_TABS.concat(EDIT_ONLY_TABS);
  const isAllowed = allowedTabs.some(t => t.trim().toLowerCase() === loggedTab.toLowerCase());
  if (!isAllowed) return { ok: false, error: 'tab not allowed: ' + loggedTab };

  const sheet = findSheet(ss, loggedTab);
  if (!sheet) return { ok: false, error: 'no tab: ' + loggedTab };

  const sheetLastRow = sheet.getLastRow();
  const sheetLastCol = sheet.getLastColumn();
  if (sheetLastRow < 1 || sheetLastCol < 1) return { ok: false, error: 'tab needs exactly one Row ID column' };

  const headers = sheet.getRange(1, 1, 1, sheetLastCol).getValues()[0].map(normHeader);
  const rowIdCols = [];
  headers.forEach((h, idx) => { if (h === 'rowid') rowIdCols.push(idx); });
  if (rowIdCols.length !== 1) return { ok: false, error: 'tab needs exactly one Row ID column' };
  if (sheetLastRow < 2) return { ok: false, error: 'row id not found' };

  const ids = sheet.getRange(2, rowIdCols[0] + 1, sheetLastRow - 1, 1).getValues();
  const hits = [];
  ids.forEach((cellId, idx) => { if (String(cellId[0] === null || cellId[0] === undefined ? '' : cellId[0]).trim() === loggedRowId) hits.push(idx + 2); });
  if (hits.length === 0) return { ok: false, error: 'row id not found' };
  if (hits.length > 1) return { ok: false, error: 'row id not unique' };
  const targetRow = hits[0];

  const colIdx = headers.indexOf(normHeader(loggedColumn));
  if (colIdx < 0) return { ok: false, error: 'column not found' };
  if (headers[colIdx] === 'timestamp' || headers[colIdx] === 'rowid') return { ok: false, error: 'column not allowed' };

  const cell = sheet.getRange(targetRow, colIdx + 1);
  if (cell.getFormula() !== '') return { ok: false, error: 'cell has a formula' };

  const tz = ss.getSpreadsheetTimeZone();
  if (!sameCell(cleanCell(cell.getValue(), tz), cleanCell(loggedNew, tz))) return { ok: false, error: 'cell changed since the edit' };

  // Log first, like editRow: if the log row cannot be written, the cell is NOT written.
  try {
    logSheet.appendRow([new Date(), sheet.getName(), loggedRowId, loggedColumn, tx_(cell.getValue()), tx_(loggedOld), 'undo']);
  } catch (logErr) {
    return { ok: false, error: 'edit log write failed' };
  }
  cell.setValue(tx_(loggedOld));
  return { ok: true, row: targetRow, undone: loggedColumn, logRow };
}

// Short unique ID for the optional "Row ID" column. Starts with a letter so Sheets never turns it into a number or date.
function makeRowId() { return 'r' + Date.now().toString(36) + (Math.random().toString(36) + '0000').slice(2, 6); }

// ROW ID BACKFILL. Google Forms writes rows straight into the sheet, so they never get a Row ID from this script.
// These two functions fill ONLY a truly empty "Row ID" cell on a row that has real data. They never change an existing ID,
// never touch a formula, never write any other cell, and never add or delete rows. Running them again changes nothing.
// ONE-TIME BACKFILL: in the Apps Script editor pick `backfillRowIds` in the function list at the top, then click Run. Check View > Executions for the count.
// AUTO-FILL NEW FORM ROWS (4 clicks): 1) click the clock icon (Triggers) on the left; 2) click Add Trigger;
// 3) choose function `fillMissingIdsOnSubmit`, event source "From spreadsheet", event type "On form submit"; 4) click Save.
// (This is NOT created by the script. Add it by hand, once.)
function fillEmptyRowIds(ss, used) {
  const counts = {};
  const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  ALLOWED_TABS.forEach(name => {
    const sheet = findSheet(ss, name);
    if (!sheet) return;
    const lastRow = sheet.getLastRow(), lastCol = sheet.getLastColumn();
    if (lastRow < 2 || lastCol < 1) return;
    const range = sheet.getRange(1, 1, lastRow, lastCol);
    const values = range.getValues(), formulas = range.getFormulas();
    const ridIdx = values[0].map(norm).indexOf('rowid');
    if (ridIdx < 0) return; // no Row ID header: this tab is left completely alone
    counts[name] = 0;
    for (let r = 1; r < lastRow; r++) {
      const v = values[r][ridIdx];
      if (v !== '' && v !== null && v !== undefined) used.add(String(v));
    }
    for (let r = 1; r < lastRow; r++) {
      const cellEmpty = values[r][ridIdx] === '' && formulas[r][ridIdx] === '';
      if (!cellEmpty) continue;
      const hasData = values[r].some((val, c) => c !== ridIdx && formulas[r][c] === '' && String(val).trim() !== '');
      if (!hasData) continue;
      let id = makeRowId();
      while (used.has(id)) id = makeRowId();
      used.add(id);
      sheet.getRange(r + 1, ridIdx + 1).setValue(id); // one empty Row ID cell, nothing else
      counts[name]++;
    }
  });
  return counts;
}

function runRowIdFill(label) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (err) {
    console.log(label + ': could not get the lock, nothing changed');
    return { ok: false, error: 'lock' };
  }
  try {
    const counts = fillEmptyRowIds(SpreadsheetApp.getActiveSpreadsheet(), new Set());
    const total = Object.keys(counts).reduce((sum, k) => sum + counts[k], 0);
    console.log(label + ' filled ' + total + ' Row IDs: ' + JSON.stringify(counts));
    return { ok: true, total: total, counts: counts };
  } finally {
    lock.releaseLock();
  }
}

// Run by hand once to fill every empty Row ID that already exists.
function backfillRowIds() { return runRowIdFill('backfillRowIds'); }
// Attach as an installable "On form submit" trigger (see the 4 clicks above).
function fillMissingIdsOnSubmit(e) { return runRowIdFill('fillMissingIdsOnSubmit'); }

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
    let body;
    try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (parseErr) { return json({ ok: false, error: 'bad json' }); }
    if (!body || typeof body !== 'object') return json({ ok: false, error: 'bad json' });

    // Signing in is the only request that needs no token: it carries a Google sign-in, which login_ checks with Google.
    if (body.action === 'login') return json(login_(body.credential));

    // Everything else needs a live session token. An empty or missing token is refused (an unset SECRET never means "open").
    if (!authOk_(body.secret)) return json({ ok: false, error: 'auth' });

    if (body.action === 'logout') { endSession_(body.secret); return json({ ok: true }); }
    if (body.action === 'read' || body.action === 'check' || body.action === 'settings_get') return json(readReply_(body));

    // Edit or delete one existing row (handled before anything that could add a row)
    if (body.action === 'edit' || body.action === 'delete') {
      const ss0 = SpreadsheetApp.getActiveSpreadsheet();
      return json(body.action === 'edit' ? editRow(ss0, body) : deleteRow(ss0, body));
    }

    // Undo the latest Edit Log change (also handled before anything that could add a row)
    if (body.action === 'undo') return json(undoRow(SpreadsheetApp.getActiveSpreadsheet(), body));

    // Save settings (themes, appearance, login record) to the "MM Settings" tab only (also handled before anything that could add a row).
    // The script lock is already held here. Newest change per setting wins; nothing else in the sheet is touched.
    if (body.action === 'settings_set') return json(writeSettings_(SpreadsheetApp.getActiveSpreadsheet(), Array.isArray(body.items) ? body.items : []));

    // Fill missing Row IDs (also handled before anything that could add a row). The script lock is already held here.
    // Same rule as the hand-run backfillRowIds: only truly empty Row ID cells on rows with real data, nothing else is written.
    if (body.action === 'backfill') {
      const counts = fillEmptyRowIds(SpreadsheetApp.getActiveSpreadsheet(), new Set());
      const total = Object.keys(counts).reduce((sum, k) => sum + counts[k], 0);
      return json({ ok: true, total: total, counts: counts });
    }

    // A trade: one Sold row and one received-device Bought row as ONE request, all or nothing (handled before the plain add path).
    // The script lock is already held here. A retry of the same id returns {ok:true, dup:true} and adds nothing.
    if (body.action === 'trade') return json(addTrade(SpreadsheetApp.getActiveSpreadsheet(), body));

    // Ignore retries of an entry that already landed
    if (seenId(body.id)) return json({ ok: true, dup: true });

    // Find the tab (ignores case and trailing spaces)
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const reqTab = String(body.tab || '').trim().toLowerCase();
    if (!ALLOWED_TABS.some(t => t.toLowerCase() === reqTab)) return json({ ok: false, error: 'tab not allowed: ' + body.tab });
    const sheet = findSheet(ss, reqTab);
    if (!sheet) return json({ ok: false, error: 'no tab: ' + body.tab });

    // Match incoming field names to column headers
    const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn() || 1).getValues()[0].map(norm);
    const inVals = body.values || {};
    const matchedCols = {}, matchedKeys = new Set();

    headers.forEach((h, idx) => {
      if (h === 'timestamp') {
        matchedCols[idx + 1] = new Date();
      } else if (h) {
        const k = Object.keys(inVals).find(key => norm(key) === h);
        if (k !== undefined) {
          matchedKeys.add(k);
          let v = inVals[k];
          if (v && typeof v === 'object' && v.$date) {
            const [y, m, d] = v.$date.split('-').map(Number);
            v = new Date(y, m - 1, d);
          }
          matchedCols[idx + 1] = v;
        }
      }
    });
    const unmatched = Object.keys(inVals).filter(k => !matchedKeys.has(k));

    // Next free row, judged only by the columns we write (formula columns are left alone)
    const cols = Object.keys(matchedCols).map(Number);
    let targetRow = 2;
    const maxRows = sheet.getMaxRows();
    if (maxRows > 1 && cols.length > 0) {
      const data = sheet.getRange(2, 1, maxRows - 1, sheet.getLastColumn()).getValues();
      for (let r = data.length - 1; r >= 0; r--) {
        if (cols.some(c => data[r][c - 1] !== '')) {
          targetRow = r + 3;
          break;
        }
      }
    }

    // Optional Row ID: only on tabs that already have a "Row ID" header, only when the request did not set it, and only when a row is really being written.
    // It joins `cols`, so the safety check below counts it and it lands in the same locked write. The next-free-row search above is unchanged.
    const ridCol = headers.indexOf('rowid') + 1;
    let rowId;
    if (ridCol > 0 && cols.length > 0) {
      const given = matchedCols[ridCol];
      if (given === undefined || given === null || String(given).trim() === '') {
        rowId = makeRowId();
        matchedCols[ridCol] = rowId;
        if (cols.indexOf(ridCol) < 0) cols.push(ridCol);
      } else {
        rowId = String(given);
      }
    }

    // Safety: never overwrite anything. Refuse if any target cell already holds a value or a formula.
    if (targetRow <= maxRows) {
      const clash = cols.some(c => { const cell = sheet.getRange(targetRow, c); return cell.getFormula() !== '' || cell.getValue() !== ''; });
      if (clash) return json({ ok: false, error: 'target row not empty' });
    }

    // Write only the cells we have values for
    if (targetRow > maxRows) sheet.insertRowsAfter(maxRows, targetRow - maxRows);
    cols.forEach(c => sheet.getRange(targetRow, c).setValue(tx_(matchedCols[c])));

    markId(body.id);
    const reply = { ok: true, row: targetRow, unmatched };
    if (rowId !== undefined) reply.rowId = rowId;
    return json(reply);
  } catch (err) {
    return json({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}
