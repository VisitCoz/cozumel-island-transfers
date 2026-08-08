/**
 * Cozumel Island Transfers — the refusal log.
 *
 * Every time the site turns a willing buyer away, one row lands here. Until
 * 2026-08-08 those guests vanished the moment they closed the tab, which left one
 * question permanently unanswerable: is the 9 AM cutoff protecting the operation,
 * or quietly running the business at 60%?
 *
 * DELIBERATELY SEPARATE from cit_bookings. Two reasons:
 *   1. The bookings script writes a reservation spreadsheet Mike explicitly did not
 *      want — the Stripe dashboard is the booking list. If this shared its
 *      BOOKINGS_URL / BOOKINGS_TOKEN, switching the refusal log on would silently
 *      switch that spreadsheet on too.
 *   2. This log holds NO personal data — no name, email, phone or card. Only the
 *      shape of the business we turned down. It is safe to share and read casually,
 *      and it should not sit behind the same credential as anything that isn't.
 *
 * ── SETUP (about ten minutes, once) ───────────────────────────────────
 * ⚠️ Sign in as contabilidad@visitcozumel.com.mx and NOTHING ELSE. Use an
 *    Incognito window if your normal Chrome is signed into several accounts.
 *    A multi-account session makes Google run the authorization as the wrong
 *    user and fail with "Error 401: invalid_client — the OAuth client is not
 *    fully created yet", which looks like a broken script and is not one.
 *    The Sheet must be OWNED by contabilidad@; that account runs the web app.
 *
 * 1. Create a Google Sheet called "CIT Lost Demand".
 * 2. Extensions → Apps Script → paste this file → Save.
 * 3. Project Settings ⚙ → Script Properties → Add:
 *      CIT_REFUSALS_TOKEN   = any long random string
 *    Generate one on the Mac, so it never travels through a chat window:
 *      python3 -c "import secrets;print(secrets.token_urlsafe(32))"
 * 4. Deploy → New deployment → type "Web app"
 *      Execute as: Me      Who has access: Anyone
 *    Approve the prompt — "Google hasn't verified this app" → Advanced →
 *    Go to (unsafe) is expected for your own script. Copy the /exec URL.
 * 5. Give Claude the /exec URL; they set REFUSALS_URL and REFUSALS_TOKEN in
 *    Netlify. Nothing else changes.
 *
 * The token only works for this one script. It cannot read your Drive, your mail,
 * or anything else.
 * ──────────────────────────────────────────────────────────────────────
 */

var SHEET = 'Refusals';

var HEADERS = [
  'Logged at (Cozumel)', 'Reason', 'Wanted date', 'Destination', 'Pax',
  'Ship', 'Pickup hour', 'Hours', 'Would have paid USD'
];

var REASON_LABEL = {
  past_cutoff:          'Past the 9 AM cutoff',
  over_40:              'Group over 40 people',
  fleet_full:           'No vehicle left that day',
  availability_unknown: 'Could not confirm a vehicle',
  payment_open_failed:  'Payment page failed to open'
};

/**
 * Optional. Generating the token on the Mac is better — running anything from this
 * editor triggers an authorization round you do not otherwise need, and that round
 * is where the wrong-account failure happens.
 */
function makeToken() {
  Logger.log(Utilities.getUuid() + Utilities.getUuid().replace(/-/g, ''));
}

function prop(k) {
  var v = PropertiesService.getScriptProperties().getProperty(k);
  return v && v.trim() ? v.trim() : null;
}

function out(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Find the spreadsheet, whichever way this script was created.
 *
 * A script made from Extensions → Apps Script is BOUND to its sheet and
 * getActiveSpreadsheet() works. A script made at script.google.com is STANDALONE and
 * that call returns null — doPost then threw, and Apps Script answered with a Google
 * "Drive: page not found" page rather than anything that explained itself. Cost an hour
 * on 2026-08-08.
 *
 * So: use the bound sheet if there is one, otherwise the one whose id we remembered,
 * otherwise create it and remember it. No configuration required in any of the cases.
 */
function spreadsheet() {
  var ss = null;
  try { ss = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) { ss = null; }
  if (ss) return ss;

  var id = prop('CIT_SHEET_ID');
  if (id) {
    try { return SpreadsheetApp.openById(id); } catch (e) { /* fall through and remake */ }
  }
  ss = SpreadsheetApp.create('CIT Lost Demand');
  PropertiesService.getScriptProperties().setProperty('CIT_SHEET_ID', ss.getId());
  return ss;
}

function sheet() {
  var ss = spreadsheet();
  var sh = ss.getSheetByName(SHEET);
  if (!sh) {
    sh = ss.insertSheet(SHEET);
    sh.appendRow(HEADERS);
    sh.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  // Column A must stay PLAIN TEXT. Left alone, Sheets helpfully parses "2026-08-08 03:57"
  // into a date value, and reading it back yields "Sat Aug 08 2026 03:57:00 GMT-0500" —
  // whose first seven characters are "Sat Aug", so every month filter matched nothing and
  // the dashboard showed zero rows while the sheet was filling up. 2026-08-08.
  sh.getRange('A:A').setNumberFormat('@');
  return sh;
}

/**
 * Read a timestamp cell back as 'YYYY-MM-DD HH:mm' no matter what Sheets turned it into.
 * Rows written before the column was pinned to text come back as Date objects; formatting
 * them in the SPREADSHEET's own timezone reproduces the wall clock that was written.
 */
function stampOf(v, ss) {
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return Utilities.formatDate(v, ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd HH:mm');
  }
  return String(v);
}

/* Cozumel is UTC-5 all year. Written as a plain string so the sheet never
   reinterprets it in the viewer's timezone. */
function cozumelStamp(iso) {
  var d = iso ? new Date(iso) : new Date();
  return Utilities.formatDate(d, 'America/Cancun', 'yyyy-MM-dd HH:mm');
}

/**
 * Everything is wrapped. An uncaught throw in here does not produce an error message —
 * Apps Script serves a generic Google "page not found" HTML page, which tells the caller
 * nothing and looks like a deployment problem. Returning the message as JSON instead means
 * the next failure explains itself in one request.
 */
function doPost(e) {
  try {
    var body;
    try { body = JSON.parse(e.postData.contents); }
    catch (err) { return out({ ok: false, error: 'bad json' }); }

    var want = prop('CIT_REFUSALS_TOKEN');
    if (!want) return out({ ok: false, error: 'CIT_REFUSALS_TOKEN is not set in Script Properties' });
    if (body.token !== want) return out({ ok: false, error: 'unauthorized' });

    if (body.action === 'record')  return out(record(body.refusal || {}));
    if (body.action === 'list')    return out(list(body.month));
    if (body.action === 'ping')    return out({ ok: true, sheet: spreadsheet().getUrl() });
    return out({ ok: false, error: 'unknown action' });
  } catch (err) {
    return out({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

/** So a browser hitting the URL gets something honest instead of a red Apps Script error. */
function doGet() {
  return out({ ok: true, note: 'CIT refusal log. POST only.' });
}

/** Append one refusal. */
function record(r) {
  var sh = sheet();
  sh.appendRow([
    cozumelStamp(r.at),
    REASON_LABEL[r.reason] || r.reason || 'unknown',
    r.wantedDate || '',
    r.destinationName || r.destination || '',
    r.pax || '',
    r.ship || '',
    r.pickupHour === null || r.pickupHour === undefined ? '' : r.pickupHour,
    r.durationHours === null || r.durationHours === undefined ? '' : r.durationHours,
    r.wouldHavePaidUsd || ''
  ]);
  return { ok: true, rows: sh.getLastRow() - 1 };
}

/** Read a month back out, newest first. `month` is 'YYYY-MM'; blank means everything. */
function list(month) {
  var sh = sheet();
  var last = sh.getLastRow();
  if (last < 2) return { ok: true, month: month || null, records: [] };

  var ss = spreadsheet();
  var vals = sh.getRange(2, 1, last - 1, HEADERS.length).getValues();
  var recs = [];
  var byReason = {};
  for (var i = 0; i < vals.length; i++) {
    var v = vals[i];
    var stamp = stampOf(v[0], ss);
    if (month && stamp.slice(0, 7) !== month) continue;
    var rec = {
      at: stamp, reasonLabel: String(v[1]), wantedDate: String(v[2]),
      destinationName: String(v[3]), pax: Number(v[4]) || null, ship: String(v[5]),
      pickupHour: v[6] === '' ? null : Number(v[6]),
      durationHours: v[7] === '' ? null : Number(v[7]),
      wouldHavePaidUsd: Number(v[8]) || 0
    };
    recs.push(rec);
    byReason[rec.reasonLabel] = (byReason[rec.reasonLabel] || 0) + 1;
  }
  recs.reverse();
  var months = {};
  for (var j = 0; j < vals.length; j++) months[stampOf(vals[j][0], ss).slice(0, 7)] = 1;
  return {
    ok: true, month: month || null, months: Object.keys(months).sort().reverse(),
    count: recs.length,
    totalUsd: recs.reduce(function (n, r) { return n + (r.wouldHavePaidUsd || 0); }, 0),
    paxTotal: recs.reduce(function (n, r) { return n + (r.pax || 0); }, 0),
    byReason: byReason,
    records: recs
  };
}
