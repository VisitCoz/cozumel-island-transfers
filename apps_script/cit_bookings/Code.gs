/**
 * Cozumel Island Transfers — bookings ledger.
 *
 * Written from scratch for CIT. Nothing here is shared with, or inherited from,
 * the Visit Cozumel or Tierra Maya scripts. Different company, different Stripe
 * account, different sheet.
 *
 * This script does NOT touch Stripe. It never sees a card, an amount it hasn't
 * been told, or a secret key. Stripe lives in the Netlify functions, because
 * only they can read the request headers needed to prove an incoming
 * "payment succeeded" really came from Stripe.
 *
 * This script owns three things Apps Script is genuinely good at:
 *   1. the spreadsheet
 *   2. the email to the team
 *   3. the Slack post
 *
 * ── SETUP ─────────────────────────────────────────────────────────────
 * 1. Create a Google Sheet called "CIT Bookings".
 * 2. Extensions → Apps Script → paste this file.
 * 3. Project Settings → Script Properties:
 *      CIT_SHARED_TOKEN    a long random string you invent (see below)
 *      CIT_SLACK_WEBHOOK   https://hooks.slack.com/services/...   (optional)
 *    Generate the token by running makeToken() once from the editor and
 *    copying what it logs. Never put it in this file.
 * 4. Deploy → New deployment → Web app
 *      Execute as: Me      Who has access: Anyone
 *    Copy the /exec URL.
 * 5. In Netlify → Site settings → Environment variables, set:
 *      BOOKINGS_URL     the /exec URL from step 4
 *      BOOKINGS_TOKEN   the same token from step 3
 *      STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET   (from your CIT Stripe account)
 * ──────────────────────────────────────────────────────────────────────
 */

var SHEET = 'Bookings';
var FLEET_RUNS_PER_DAY = 100;      // 20 vans × up to 5 runs
var WARN_AT = 0.8;

var TEAM_EMAILS = [
  'hello@cozumelislandtransfers.com'
  // add Adela / Angel / Mario here once confirmed
];

var HEADERS = [
  'Recorded at', 'Ref', 'Stripe session', 'Date', 'Pickup', 'Return',
  'Destination', 'Pax', 'Vehicle', 'Ship', 'Guest', 'Email', 'WhatsApp',
  'Paid USD', 'Admission prepaid', 'Driver', 'Notes'
];

/** Run this once from the editor, then paste the result into Script Properties. */
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

function sheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET);
  if (!sh) {
    sh = ss.insertSheet(SHEET);
    sh.appendRow(HEADERS);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
  }
  return sh;
}

var COL = { REF: 1, SESSION: 2, DATE: 3 };   // zero-based into a row array

/** How many paid runs already exist on a date. Feeds the allotment guard. */
function countRuns(dateIso) {
  var rows = sheet().getDataRange().getValues();
  var n = 0;
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][COL.DATE]) === String(dateIso)) n++;
  }
  return n;
}

/** True if this Stripe session was already written. Makes retries harmless. */
function alreadyRecorded(sessionId) {
  var rows = sheet().getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][COL.SESSION]) === String(sessionId)) return true;
  }
  return false;
}

function recordBooking(b) {
  if (!b || !b.sessionId) return out({ error: 'no session id' });

  // Stripe retries for up to three days. Writing twice would double-count the
  // allotment and double-notify the team, so this check is load-bearing.
  if (alreadyRecorded(b.sessionId)) {
    return out({ recorded: false, duplicate: true });
  }

  sheet().appendRow([
    new Date(), b.ref, b.sessionId, b.date, b.pickup, b.ret,
    b.destinationName || b.destination, b.pax, b.vehicleName || b.vehicle,
    b.ship, b.guest, b.email, b.whatsapp,
    b.amountUsd, b.admissionPrepaid ? 'yes' : 'no', '', ''
  ]);

  var runs = countRuns(b.date);
  try { postSlack(b, runs); } catch (e) { Logger.log('slack failed: ' + e); }
  try { emailTeam(b, runs); } catch (e) { Logger.log('email failed: ' + e); }

  return out({ recorded: true, runsOnDate: runs });
}

function postSlack(b, runs) {
  var hook = prop('CIT_SLACK_WEBHOOK');
  if (!hook) return;

  var wa = String(b.whatsapp || '').replace(/[^0-9]/g, '');
  var lines = [
    '*' + (b.guest || 'Guest') + '* · ' + b.pax + ' to *' + (b.destinationName || b.destination) + '*',
    b.date + '  ' + b.pickup + '–' + b.ret + '   ' + (b.ship || ''),
    '$' + Number(b.amountUsd).toFixed(2) + ' USD paid' +
      (b.admissionPrepaid ? ' (admission included)' : '') + '   ref ' + b.ref,
    wa ? '<https://wa.me/' + wa + '|Message ' + (b.guest || 'the guest') + ' on WhatsApp>' : ''
  ];
  if (runs >= FLEET_RUNS_PER_DAY * WARN_AT) {
    lines.push(':warning: *' + runs + ' of ' + FLEET_RUNS_PER_DAY + ' runs booked on ' + b.date + '*');
  }

  UrlFetchApp.fetch(hook, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ text: lines.filter(String).join('\n') }),
    muteHttpExceptions: true
  });
}

function emailTeam(b, runs) {
  if (!TEAM_EMAILS.length) return;
  var subject = 'Booking · ' + (b.destinationName || b.destination) + ' · ' +
                b.date + ' · ' + b.pax + ' pax';
  var body = [
    'Ref ' + b.ref,
    '',
    (b.guest || '') + '   ' + (b.email || '') + '   ' + (b.whatsapp || ''),
    'To: ' + (b.destinationName || b.destination),
    'Date: ' + b.date,
    'Pickup: ' + b.pickup + '    Back: ' + b.ret,
    'Ship: ' + (b.ship || ''),
    'Vehicle: ' + (b.vehicleName || b.vehicle) + '   Pax: ' + b.pax,
    'Paid: $' + Number(b.amountUsd).toFixed(2) + ' USD' +
      (b.admissionPrepaid ? '  (includes venue admission)' : ''),
    '',
    'Runs booked on ' + b.date + ': ' + runs + ' of ' + FLEET_RUNS_PER_DAY
  ].join('\n');

  TEAM_EMAILS.forEach(function (e) { MailApp.sendEmail(e, subject, body); });
}

/** Tomorrow's runs, for the 6 AM dispatch digest. Add a time trigger for this. */
function dailyDigest() {
  var tz = 'America/Cancun';
  var tomorrow = Utilities.formatDate(
    new Date(Date.now() + 24 * 3600 * 1000), tz, 'yyyy-MM-dd');

  var rows = sheet().getDataRange().getValues();
  var runs = [];
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][COL.DATE]) === tomorrow) runs.push(rows[i]);
  }
  if (!runs.length) return;

  runs.sort(function (a, b) { return String(a[4]).localeCompare(String(b[4])); });

  var lines = ['*Tomorrow — ' + tomorrow + '* · ' + runs.length + ' runs'];
  runs.forEach(function (r) {
    lines.push('• ' + r[4] + '  ' + r[6] + '  ' + r[7] + ' pax  ' + r[8] +
               (r[15] ? '  → ' + r[15] : '  → *no driver yet*'));
  });

  var hook = prop('CIT_SLACK_WEBHOOK');
  if (hook) {
    UrlFetchApp.fetch(hook, {
      method: 'post', contentType: 'application/json',
      payload: JSON.stringify({ text: lines.join('\n') }), muteHttpExceptions: true
    });
  }
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);

    // The only gate on this endpoint. It is deployed as "Anyone", because the
    // Netlify function calls it without a Google login.
    var expected = prop('CIT_SHARED_TOKEN');
    if (!expected || body.token !== expected) return out({ error: 'unauthorized' });

    if (body.action === 'countRuns')     return out({ runs: countRuns(body.date) });
    if (body.action === 'recordBooking') return recordBooking(body.booking);
    return out({ error: 'unknown action' });
  } catch (err) {
    return out({ error: String(err) });
  }
}

function doGet() {
  return ContentService.createTextOutput('CIT bookings endpoint OK');
}
