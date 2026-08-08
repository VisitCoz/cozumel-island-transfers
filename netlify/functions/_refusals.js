// The refusal log — every time a business rule turns money away.
//
// WHY THIS EXISTS
// Until 2026-08-08 a refused guest vanished the moment she closed the tab. Her date, her
// destination, her group size, the reason we said no: gone. That made one question
// unanswerable — is the 9 AM cutoff protecting the operation, or quietly running the
// business at 60%? Every day without this log is a day of that evidence lost for good.
//
// WHAT IS NOT LOGGED
// Form validation is not a refusal. A missing name or a malformed date is a stale browser
// tab, not lost demand, and logging it would bury the signal. Only the five BUSINESS rules
// are recorded — the ones that route a real, willing buyer to WhatsApp.
//
// NO PERSONAL DATA. No name, no email, no phone, no card. Just the shape of the business we
// turned down. Nothing here needs protecting, which is why it can be read casually.
//
// WHERE IT GOES, AND WHY NOT NETLIFY BLOBS
// Blobs was built first and abandoned on 2026-08-08. This site's runtime does not inject
// NETLIFY_BLOBS_CONTEXT — verified by reading the function's own environment — and the
// internal NETLIFY_FUNCTIONS_TOKEN returns 401 against the Blobs API. The only way through
// was a Netlify personal access token, which cannot be scoped: it would have put full
// account access into a public-facing function to store data that isn't even sensitive.
// A Google Sheet behind its own single-purpose token is the better trade, and it has the
// side benefit that Mike and Iris can just open it and look.
//
// DELIBERATELY its own URL and token, not BOOKINGS_URL/BOOKINGS_TOKEN: those switch on the
// bookings spreadsheet, which Mike explicitly did not want. Turning on the refusal log must
// not silently turn that on too.

const REFUSALS_URL = () => process.env.REFUSALS_URL;
const REFUSALS_TOKEN = () => process.env.REFUSALS_TOKEN;

// Best-effort value of what walked away, using our own list price. For a group too big for
// any single vehicle, assume the buses it would have taken — a 60-person group is two runs.
const BUS_MAX = 40, BUS_USD = 899;
function estimateUsd(pax, vehicleUsd) {
  if (vehicleUsd) return vehicleUsd;
  if (!pax || pax < 1) return null;
  return Math.ceil(pax / BUS_MAX) * BUS_USD;
}

/* Cozumel is UTC-5 year round. Bucket by LOCAL month so "October" means what Mike means. */
function monthKey(d = new Date()) {
  return new Date(d.getTime() - 5 * 3600 * 1000).toISOString().slice(0, 7);
}

async function call(action, payload, timeoutMs = 4000) {
  const url = REFUSALS_URL(), token = REFUSALS_TOKEN();
  if (!url || !token) throw new Error('REFUSALS_URL / REFUSALS_TOKEN not set');
  // Apps Script can be slow to wake. A guest is already being refused, so never make her
  // wait on our bookkeeping — give up and move on.
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, action, ...payload }),
      signal: ctl.signal,
      redirect: 'follow',              // Apps Script /exec always 302s to its runtime host
    });
    const text = await res.text();
    try { return JSON.parse(text); }
    catch { throw new Error(`Refusal log returned non-JSON: ${text.slice(0, 160)}`); }
  } finally { clearTimeout(t); }
}

/**
 * Record one refusal. Never throws, never blocks the guest's response on a storage problem —
 * losing a log line is annoying, failing her checkout over it is not acceptable.
 */
async function logRefusal(r) {
  const refusal = {
    at: new Date().toISOString(),
    reason: r.reason,                       // past_cutoff | over_40 | fleet_full | availability_unknown | payment_open_failed
    wantedDate: r.wantedDate || null,
    destination: r.destination || null,
    destinationName: r.destinationName || null,
    pax: Number(r.pax) || null,
    ship: r.ship || null,
    pickupHour: r.pickupHour ?? null,
    durationHours: r.durationHours ?? null,
    wouldHavePaidUsd: estimateUsd(r.pax, r.vehicleUsd),
  };
  try {
    const out = await call('record', { refusal });
    if (!out || out.ok !== true) throw new Error(out && out.error ? out.error : 'unknown');
    return true;
  } catch (err) {
    // Loud in the logs, invisible to the guest.
    console.error('refusal log failed (booking flow unaffected)', refusal.reason, err && err.message);
    return false;
  }
}

/** Read a month back out. `month` is 'YYYY-MM'; defaults to the current Cozumel month. */
async function listRefusals(month) {
  const out = await call('list', { month: month || monthKey() }, 10000);
  if (!out || out.ok !== true) throw new Error(out && out.error ? out.error : 'list failed');
  return out;
}

const isConfigured = () => !!(REFUSALS_URL() && REFUSALS_TOKEN());

module.exports = { logRefusal, listRefusals, monthKey, isConfigured };
