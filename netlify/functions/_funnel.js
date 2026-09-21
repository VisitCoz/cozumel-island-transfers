// The booking funnel — where visitors actually go, and where they stop.
//
// WHY THIS EXISTS
// Until 2026-08-15 this site had no analytics of any kind. Stripe said who paid and the
// refusal log said who a rule turned away; the far larger group who arrived, looked and
// left was invisible. That made the most important question unanswerable: is the problem
// that nobody comes, or that they come and don't book? Those need opposite fixes.
//
// WHY NOT GOOGLE ANALYTICS
// GA sets non-essential cookies, which under GDPR/ePrivacy requires a consent banner. The
// visitor is a cruise passenger on metered ship wifi deciding in about ninety seconds, and
// a consent wall would be the first thing she sees. This site currently sets NO cookies at
// all — that is an asset, and it is worth more than anything GA reports. Traffic and
// referrers come from Cloudflare Web Analytics (cookieless, server-side); the funnel comes
// from here. Neither needs a banner.
//
// NO PERSONAL DATA. No name, email, phone, card or IP. The session id is a random string
// in sessionStorage, which dies with the tab and cannot follow anyone anywhere.
//
// DELIBERATELY its own URL and token, matching _refusals.js. One token per job means
// switching the funnel on cannot silently switch the bookings spreadsheet on too.

const FUNNEL_URL = () => process.env.FUNNEL_URL;
const FUNNEL_TOKEN = () => process.env.FUNNEL_TOKEN;

// THE FUNNEL, in order. Must stay identical to TRACK_STEPS in index.html and to the first
// eight entries of STEPS in apps_script/cit_funnel/Code.gs. The order IS the funnel; the
// three lists drifting apart is the one way this gets quietly wrong.
//
// Rewritten 2026-09-21. The previous list was the six-screen wizard's, and those screens
// were deleted on 2026-09-19 — so for two days the funnel could only say who arrived and
// who reached Stripe, with nothing in between. These are the moments the one-page flow
// actually has.
const STEPS = [
  'land',        // the page loaded. Everything else is a fraction of this.
  'ship',        // picked a ship, or said she is not on a cruise
  'place',       // committed a destination — list, Google suggestion, or typed
  'pax',         // moved the head count, or asked for a price with it as it stood
  'price_seen',  // the price card rendered — a number, or "we'll confirm on WhatsApp"
  'form_open',   // "Book this transfer" opened the one booking screen
  'pay',         // pressed Pay on Stripe and create-checkout answered with a URL
  'done',        // came back on the success URL
];

// Steps the deleted wizard sent. The page never sends them again, but they stay ACCEPTED
// — a tab left open on the old build still deserves to be written down rather than
// dropped, and rows already in the sheet still deserve a label. They are appended AFTER
// STEPS in Code.gs for the same reason, and they are shown below the live funnel only if
// any actually have rows. 'checkout_open' is the old name for what is now 'pay'.
const LEGACY_STEPS = ['hub', 'dest', 'day', 'who', 'checkout_open'];

// What Code.gs accepts, in its order. Keep the two in step.
const ALL_STEPS = STEPS.concat(LEGACY_STEPS);

const STEP_LABEL = {
  land:          'Landed on the site',
  ship:          'Named their ship (or said they are not on a cruise)',
  place:         'Chose where they are going',
  pax:           'Set the group size',
  price_seen:    'Saw the price',
  form_open:     'Opened the booking form',
  pay:           'Pressed Pay on Stripe',
  done:          'Booked',
  // the wizard's, kept so an old row still reads as English
  hub:           'Opened the booking form (old wizard)',
  dest:          'Chose a destination (old wizard)',
  day:           'Picked the date and times (old wizard)',
  who:           'Entered their details (old wizard)',
  checkout_open: 'Opened Stripe checkout (old wizard)',
};

/* Cozumel is UTC-5 year round. Bucket by LOCAL month so "August" means what Mike means. */
function monthKey(d = new Date()) {
  return new Date(d.getTime() - 5 * 3600 * 1000).toISOString().slice(0, 7);
}

async function call(action, payload, timeoutMs = 9000) {
  const url = FUNNEL_URL(), token = FUNNEL_TOKEN();
  if (!url || !token) throw new Error('FUNNEL_URL / FUNNEL_TOKEN not set');
  // Apps Script can be slow to wake. Nobody is waiting on this — the browser already sent
  // it with sendBeacon and moved on — but a hung fetch still ties up the function.
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, action, ...payload }),
      signal: ctl.signal,
      redirect: 'follow',            // Apps Script /exec always 302s to its runtime host
    });
    const text = await res.text();
    try { return JSON.parse(text); }
    catch { throw new Error(`Funnel log returned non-JSON: ${text.slice(0, 160)}`); }
  } finally { clearTimeout(t); }
}

/**
 * Record one step. Never throws — losing a funnel row is a rounding error, and this
 * endpoint is reachable from any browser, so it must never be able to break anything.
 */
async function logStep(ev) {
  const event = {
    sid: String(ev.sid || '').slice(0, 24),
    step: ev.step,
    dest: ev.dest ? String(ev.dest).slice(0, 40) : null,
    pax: Number(ev.pax) || null,
    source: ev.source ? String(ev.source).slice(0, 60) : 'direct',
    device: ev.device === 'mobile' || ev.device === 'desktop' ? ev.device : '',
    // Who she is and where she is trying to go. The ship is the guest's own answer to
    // "which ship" and the line comes with it from the ship list; place_text is the words
    // in the destination box. None of the three is a person — no name, email or phone has
    // ever entered this funnel and none may start now. Truncated because this endpoint is
    // open to any browser and a spreadsheet cell is not a place to discover that.
    ship: ev.ship ? String(ev.ship).trim().slice(0, 60) : '',
    line: ev.line ? String(ev.line).trim().slice(0, 40) : '',
    place_text: ev.place_text ? String(ev.place_text).trim().slice(0, 120) : '',
  };
  try {
    const out = await call('record', { event });
    return !!(out && out.ok === true);
  } catch (err) {
    console.error('funnel log failed (site unaffected)', event.step, err && err.message);
    return false;
  }
}

/** Read a month back out. `month` is 'YYYY-MM'; defaults to the current Cozumel month. */
async function listSteps(month) {
  const out = await call('list', { month: month || monthKey() }, 10000);
  if (!out || out.ok !== true) throw new Error(out && out.error ? out.error : 'list failed');
  return out;
}

const isConfigured = () => !!(FUNNEL_URL() && FUNNEL_TOKEN());

module.exports = { logStep, listSteps, monthKey, isConfigured,
                   STEPS, LEGACY_STEPS, ALL_STEPS, STEP_LABEL };
