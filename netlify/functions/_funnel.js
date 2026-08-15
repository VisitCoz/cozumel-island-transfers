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

// Must stay in the same order as STEPS in apps_script/cit_funnel/Code.gs. The order IS the
// funnel; the two lists drifting apart is the one way this gets quietly wrong.
const STEPS = [
  'land', 'hub', 'dest', 'pax', 'ship', 'day', 'who', 'pay', 'checkout_open', 'done',
];

const STEP_LABEL = {
  land:          'Landed on the site',
  hub:           'Opened the booking form',
  dest:          'Chose a destination',
  pax:           'Set the group size (saw the price)',
  ship:          'Named their ship',
  day:           'Picked the date and times',
  who:           'Entered their details',
  pay:           'Reached the payment screen',
  checkout_open: 'Opened Stripe checkout',
  done:          'Booked',
};

/* Cozumel is UTC-5 year round. Bucket by LOCAL month so "August" means what Mike means. */
function monthKey(d = new Date()) {
  return new Date(d.getTime() - 5 * 3600 * 1000).toISOString().slice(0, 7);
}

async function call(action, payload, timeoutMs = 4000) {
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

module.exports = { logStep, listSteps, monthKey, isConfigured, STEPS, STEP_LABEL };
