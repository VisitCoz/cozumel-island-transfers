/**
 * Cozumel Island Transfers — the booking funnel.
 *
 * Stripe tells us who paid. The refusal log tells us who a business rule turned away.
 * Between those two sits the largest group of all — the people who arrived, looked, and
 * left on their own — and until now they were completely invisible. A site with no
 * bookings and a site with no visitors look identical from the Stripe dashboard.
 *
 * One row per SESSION per STEP, written the first time that session reaches that step.
 * Going back and forward does not write again, so the sheet stays small and "reached
 * step N" means what it says.
 *
 * NO PERSONAL DATA, NO COOKIES. No name, email, phone, card or IP. The session id is a
 * random string held in sessionStorage — it dies when the tab closes, it cannot follow
 * anyone to another site, and it is not a cookie, which is precisely why this site still
 * needs no consent banner. Do not add one without re-reading that sentence.
 *
 * DELIBERATELY SEPARATE from cit_refusals and cit_bookings, for the same reason those two
 * are separate from each other: one token per job, so switching this on cannot silently
 * switch anything else on.
 *
 * ── SETUP (about ten minutes, once) ───────────────────────────────────
 * ⚠️ Sign in as contabilidad@visitcozumel.com.mx and NOTHING ELSE. Use an Incognito
 *    window if your normal Chrome is signed into several accounts. A multi-account
 *    session makes Google run the authorization as the wrong user and fail with
 *    "Error 401: invalid_client", which looks like a broken script and is not one.
 *    The Sheet must be OWNED by contabilidad@; that account runs the web app.
 *
 * 1. Create a Google Sheet called "CIT Funnel".
 * 2. Extensions → Apps Script → paste this file → Save.
 * 3. Project Settings ⚙ → Script Properties → Add:
 *      CIT_FUNNEL_TOKEN = any long random string
 *    Generate it on the Mac so it never travels through a chat window:
 *      python3 -c "import secrets;print(secrets.token_urlsafe(32))"
 * 4. Deploy → New deployment → type "Web app"
 *      Execute as: Me      Who has access: Anyone
 *    "Google hasn't verified this app" → Advanced → Go to (unsafe) is expected for
 *    your own script. Copy the /exec URL.
 * 5. Give Claude the /exec URL; they set FUNNEL_URL and FUNNEL_TOKEN in Netlify.
 *
 * The token only works for this one script. It cannot read your Drive or your mail.
 * ──────────────────────────────────────────────────────────────────────
 */

var SHEET = 'Funnel';

var HEADERS = [
  'Logged at (Cozumel)', 'Session', 'Step', 'Step no', 'Destination', 'Pax',
  'Source', 'Device'
];

/**
 * The order matters — it IS the funnel. Adding a step in the middle renumbers the ones
 * after it, which is fine going forward but makes old rows and new rows incomparable.
 * Append new steps at the end unless you genuinely want to break the history.
 */
var STEPS = [
  'land',           // the page loaded. Everything else is a fraction of this.
  'hub',            // opened the booking wizard
  'dest',           // chose a destination
  'pax',            // set the head count — this is where she first sees a price
  'ship',           // named her ship
  'day',            // set the date and times
  'who',            // typed her details
  'pay',            // reached the review-and-pay screen
  'checkout_open',  // Stripe checkout actually opened
  'done'            // came back on the success URL
];

var STEP_LABEL = {
  land:          'Landed on the site',
  hub:           'Opened the booking form',
  dest:          'Chose a destination',
  pax:           'Set the group size (saw the price)',
  ship:          'Named their ship',
  day:           'Picked the date and times',
  who:           'Entered their details',
  pay:           'Reached the payment screen',
  checkout_open: 'Opened Stripe checkout',
  done:          'Booked'
};

function stepNo_(step) {
  var i = STEPS.indexOf(step);
  return i < 0 ? '' : i + 1;
}

/* Cozumel is UTC-5 all year. Stamp in local time so a row reads the way Mike thinks. */
function stamp_(d) {
  return Utilities.formatDate(d || new Date(), 'America/Cancun', 'yyyy-MM-dd HH:mm');
}

function monthKey_(d) {
  return Utilities.formatDate(d || new Date(), 'America/Cancun', 'yyyy-MM');
}

/**
 * One tab per month. The refusal log learned this the hard way: a single sheet that grows
 * forever eventually makes every read slow, and Mike reads these by opening them.
 */
function sheetFor_(month) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var name = SHEET + ' ' + month;
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(HEADERS);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
  }
  return sh;
}

function ok_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  var body;
  try { body = JSON.parse(e.postData.contents); }
  catch (err) { return ok_({ ok: false, error: 'bad JSON' }); }

  var want = PropertiesService.getScriptProperties().getProperty('CIT_FUNNEL_TOKEN');
  if (!want || body.token !== want) return ok_({ ok: false, error: 'bad token' });

  if (body.action === 'record') return record_(body.event || {});
  if (body.action === 'list')   return list_(body.month);
  return ok_({ ok: false, error: 'unknown action: ' + body.action });
}

function record_(ev) {
  // An unknown step is almost always a stale browser running an old build. Drop it rather
  // than letting it into the funnel, where it would sit at position '' and confuse totals.
  if (STEPS.indexOf(ev.step) < 0) return ok_({ ok: false, error: 'unknown step' });
  if (!ev.sid) return ok_({ ok: false, error: 'no session' });

  var now = new Date();
  var lock = LockService.getScriptLock();
  // Two tabs from the same visitor can land in the same instant. Without the lock they
  // race for the same row and one of them is silently lost.
  try { lock.waitLock(8000); } catch (err) { return ok_({ ok: false, error: 'busy' }); }
  try {
    sheetFor_(monthKey_(now)).appendRow([
      stamp_(now),
      String(ev.sid).slice(0, 24),
      ev.step,
      stepNo_(ev.step),
      ev.dest || '',
      ev.pax || '',
      ev.source || 'direct',
      ev.device || ''
    ]);
  } finally { lock.releaseLock(); }
  return ok_({ ok: true });
}

function list_(month) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var m = /^\d{4}-\d{2}$/.test(month || '') ? month : monthKey_();
  var sh = ss.getSheetByName(SHEET + ' ' + m);

  var months = ss.getSheets()
    .map(function (s) { return s.getName(); })
    .filter(function (n) { return n.indexOf(SHEET + ' ') === 0; })
    .map(function (n) { return n.slice(SHEET.length + 1); })
    .sort().reverse();

  if (!sh) return ok_({ ok: true, month: m, months: months, records: [] });

  var values = sh.getDataRange().getValues();
  var records = [];
  for (var i = 1; i < values.length; i++) {
    var r = values[i];
    if (!r[0]) continue;
    records.push({
      at: (r[0] instanceof Date) ? stamp_(r[0]) : String(r[0]),
      sid: String(r[1]),
      step: String(r[2]),
      stepNo: Number(r[3]) || null,
      dest: String(r[4] || ''),
      pax: Number(r[5]) || null,
      source: String(r[6] || ''),
      device: String(r[7] || '')
    });
  }
  return ok_({ ok: true, month: m, months: months, records: records, labels: STEP_LABEL, steps: STEPS });
}

/**
 * Run this ONCE from the editor (▶ Run, with setupToken selected).
 *
 * It mints the shared secret and stores it here, then prints it in the execution log.
 * Copy it straight from the log into Netlify → Site configuration → Environment
 * variables as FUNNEL_TOKEN, alongside FUNNEL_URL.
 *
 * Generated here rather than handed over in a chat window on purpose: the secret goes
 * from this log to Netlify and touches nothing in between.
 *
 * Safe to run twice — it will not replace a token that already exists, because doing so
 * would silently break the live site until Netlify was updated to match.
 */
function setupToken() {
  var props = PropertiesService.getScriptProperties();
  var existing = props.getProperty('CIT_FUNNEL_TOKEN');
  if (existing) {
    Logger.log('Already set up. FUNNEL_TOKEN = ' + existing);
    return existing;
  }
  var chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var t = '';
  for (var i = 0; i < 40; i++) t += chars.charAt(Math.floor(Math.random() * chars.length));
  props.setProperty('CIT_FUNNEL_TOKEN', t);
  Logger.log('FUNNEL_TOKEN = ' + t);
  Logger.log('Put that in Netlify as FUNNEL_TOKEN. FUNNEL_URL is the /exec URL of this deployment.');
  return t;
}

/** Health check: run this from the editor to confirm the token is set. */
function checkSetup() {
  var t = PropertiesService.getScriptProperties().getProperty('CIT_FUNNEL_TOKEN');
  Logger.log(t ? 'CIT_FUNNEL_TOKEN is set (' + t.length + ' chars).'
               : 'CIT_FUNNEL_TOKEN is MISSING — run setupToken().');
}
