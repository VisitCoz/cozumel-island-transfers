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
// turned down. Nothing here needs protecting, which is why it can be read by a weekly agent
// without anyone thinking hard about it.

const { getStore } = require('@netlify/blobs');

const STORE = 'refusals';

// This site's runtime does NOT inject NETLIFY_BLOBS_CONTEXT — verified 2026-08-08 by reading
// the function's own environment. SITE_ID is there, so only a token is missing. Try the
// credentials Netlify already provides before asking anyone to mint a personal access token,
// which would carry full account access into a public-facing function.
function store() {
  const siteID = process.env.SITE_ID;
  const token = process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_FUNCTIONS_TOKEN;
  return (siteID && token) ? getStore({ name: STORE, siteID, token }) : getStore(STORE);
}

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

/**
 * Record one refusal. Never throws, never blocks the guest's response on a storage problem —
 * losing a log line is annoying, failing her checkout over it is not acceptable.
 */
async function logRefusal(r) {
  try {
    const now = new Date();
    const rec = {
      at: now.toISOString(),
      reason: r.reason,                       // past_cutoff | over_40 | fleet_full | availability_unknown | payment_open_failed
      wantedDate: r.wantedDate || null,       // the day she asked for
      destination: r.destination || null,
      destinationName: r.destinationName || null,
      pax: Number(r.pax) || null,
      ship: r.ship || null,
      pickupHour: r.pickupHour ?? null,
      durationHours: r.durationHours ?? null,
      wouldHavePaidUsd: estimateUsd(r.pax, r.vehicleUsd),
    };
    // One blob per refusal. Appending to a shared array would lose writes whenever two
    // guests are refused in the same second, which is exactly when a busy day refuses people.
    const key = `${monthKey(now)}/${now.toISOString()}-${Math.random().toString(36).slice(2, 8)}`;
    await store().setJSON(key, rec);
    return true;
  } catch (err) {
    console.error('refusal log failed (booking flow unaffected)', r && r.reason, err);
    return false;
  }
}

/** Read a month back out. `month` is 'YYYY-MM'; defaults to the current Cozumel month. */
async function listRefusals(month) {
  const prefix = `${month || monthKey()}/`;
  const st = store();
  const { blobs } = await st.list({ prefix });
  const out = await Promise.all(
    blobs.map(b => st.get(b.key, { type: 'json' }).catch(() => null))
  );
  return out.filter(Boolean).sort((a, b) => (a.at < b.at ? 1 : -1));
}

/** Which months have anything in them — so a dashboard can offer a real month picker. */
async function refusalMonths() {
  const { directories } = await store().list({ prefix: '', directories: true });
  return (directories || []).sort().reverse();
}

module.exports = { logRefusal, listRefusals, refusalMonths, monthKey };
