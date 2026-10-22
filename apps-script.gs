// My Money sheet connector v3: reads AND writes your sheet.
// HOW TO INSTALL: open your Google Sheet > Extensions > Apps Script. Select ALL the old code, delete it, paste this,
// press Save. Then Deploy > Manage deployments > pencil icon > Version: New version > Deploy.
// Keep "Execute as: Me" and "Who has access: Anyone". The /exec link stays the same.
// HOW TO CHECK IT: open your /exec link with ?action=check on the end. It lists every tab it reads and any problems.
const SECRET = ''; // optional: a word here AND the same word in My Money > Log > Sheet connection

// WRITE: these are the ONLY tabs entries can be added to (matched ignoring case and spaces).
// Summary, Master Inventory, PCs, PnA and the other formula tabs are not listed, so they can never be touched.
const ALLOWED_TABS = ['Form Responses - Bought', 'Form Responses - PCs', 'Bought Access - Form', 'Form Responses - Sold', 'Form Responses - Sold PCs', 'Sold Access - Form', 'Expenses', 'Investment Tracking Sheet'];

// READ: what the website loads. key = the site's name, tab = your tab, keys = columns that prove a row is real data.
// Reading never changes anything in the sheet.
const READ_TABS = {
  Expenses:    { tab: 'Expenses',                  keys: ['Item Purchased', 'Amount', 'Date of Purchase'] },
  Phones:      { tab: 'Master Inventory',          keys: ['Model', 'IMEI', 'Device Label'] },
  PCs:         { tab: 'PCs',                       keys: ['PC model', 'Device Label'] },
  Accessories: { tab: 'PnA',                       keys: ['Item ID', 'Model', 'Brand'] },
  Investments: { tab: 'Investment Tracking Sheet', keys: ['Investment Type', 'Date', 'Total Portfolio Value'] }
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
  });
  return out;
}

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.action !== 'read' && p.action !== 'check') return json({ ok: true, service: 'my-money-entry', version: 3, read: true });
  if (SECRET && p.secret !== SECRET) return json({ ok: false, error: 'auth' });
  try {
    if (p.action === 'check') return json({ ok: true, version: 3, at: new Date().toISOString(), tabs: checkAll() });
    const tabs = readAll();
    const reply = { ok: true, version: 3, at: new Date().toISOString(), tabs: tabs };
    if (p.flat === '1') reply.data = flatten(tabs); // ?action=read&flat=1 -> { status: "success", data: [...] }
    return json(reply);
  } catch (err) {
    return json({ ok: false, error: String(err) });
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

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
    let body;
    try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (parseErr) { return json({ ok: false, error: 'bad json' }); }
    if (!body || typeof body !== 'object') return json({ ok: false, error: 'bad json' });
    if (SECRET && body.secret !== SECRET) return json({ ok: false, error: 'auth' });

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

    // Safety: never overwrite anything. Refuse if any target cell already holds a value or a formula.
    if (targetRow <= maxRows) {
      const clash = cols.some(c => { const cell = sheet.getRange(targetRow, c); return cell.getFormula() !== '' || cell.getValue() !== ''; });
      if (clash) return json({ ok: false, error: 'target row not empty' });
    }

    // Write only the cells we have values for
    if (targetRow > maxRows) sheet.insertRowsAfter(maxRows, targetRow - maxRows);
    cols.forEach(c => sheet.getRange(targetRow, c).setValue(matchedCols[c]));

    markId(body.id);
    return json({ ok: true, row: targetRow, unmatched });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}
