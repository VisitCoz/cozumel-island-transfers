// GET /.netlify/functions/preview-emails
//
// Shows the three emails this system sends, rendered from the SAME code that
// sends them, filled with a plausible fake booking. Read-only and harmless.
//
// GET /.netlify/functions/preview-emails?send=1&token=…
//   actually mails all three to TEAM_EMAILS, so you can see them land in Gmail
//   on a phone rather than trusting a desktop preview. The token is required:
//   without it this URL would email the team every time a crawler found it.

const { sendEmail, teamEmails } = require('./_cit');
const {
  bookingEmail, bookingSubject,
  manifestEmail, manifestSubject,
  guestEmail, guestSubject,
  confirmationEmail, confirmationSubject,
} = require('./_emails');

// A believable booking. Not a real guest.
const DATE = '2026-11-14';

const META = {
  booking_ref: 'CIT-4KP2XQ',
  destination: 'mr-sanchos',
  destination_name: 'Mr. Sanchos',
  date: DATE,
  pickup: '9:00 AM',
  ret: '3:00 PM',
  pax: '6',
  vehicle: 'van_1_8',
  vehicle_name: 'Private van',
  ship: 'Carnival Breeze',
  guest: 'Linda Harper',
  email: 'linda.harper@example.com',
  whatsapp: '+1 407 555 0142',
  admission_prepaid: 'false',
};

const RUNS = [
  { ref: 'CIT-4KP2XQ', pickup: '9:00 AM',  ret: '3:00 PM', destination: 'Mr. Sanchos',
    pax: 6, vehicle: 'Private van', ship: 'Carnival Breeze',
    guest: 'Linda Harper', email: 'linda.harper@example.com' },
  { ref: 'CIT-8ZR1MD', pickup: '9:30 AM',  ret: '2:30 PM', destination: 'Tierra Maya',
    pax: 2, vehicle: 'Private van', ship: 'Celebrity Equinox',
    guest: 'Robert Kingsley', email: 'r.kingsley@example.com' },
  { ref: 'CIT-QW77TN', pickup: '10:00 AM', ret: '4:00 PM', destination: 'Chankanaab',
    pax: 12, vehicle: 'Large private van', ship: 'MSC Divina',
    guest: 'Patricia Nolan', email: 'p.nolan@example.com' },
];

const EMAILS = [
  { key: 'confirmation',
    goesTo: 'The guest, the moment her card clears',
    when: 'Sent by stripe-webhook.js. She may book three weeks before she sails — until 2026-08-08 this did not exist and her first word from us was the day-before email.',
    subject: confirmationSubject(META),
    html: confirmationEmail(META, 369, 'USD', META.email) },
  { key: 'booking',
    goesTo: 'The team, the moment a card clears',
    when: 'Sent by stripe-webhook.js. Reply-to is the guest, so hitting Reply in Gmail reaches them.',
    subject: bookingSubject(META),
    html: bookingEmail(META, 369, 'USD', META.email) },
  { key: 'manifest',
    goesTo: 'The team, 9 AM Cozumel time, the day before',
    when: 'Sent by daily-manifest.js. Nothing is sent at all on a day with no bookings.',
    subject: manifestSubject(DATE, RUNS),
    html: manifestEmail(DATE, RUNS) },
  { key: 'guest',
    goesTo: 'Each guest, 9 AM Cozumel time, the day before',
    when: 'Meeting point and times only — no driver, no vehicle, no plate. Nothing has to be assigned a day ahead.',
    subject: guestSubject(RUNS[0]),
    html: guestEmail(RUNS[0]) },
];

const page = (notice) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>CIT — what the emails look like</title>
<style>
  :root { color-scheme: light }
  body { margin:0; background:#EEF2F5; color:#0E0E10; line-height:1.5;
         font:15px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif }
  .wrap { max-width:680px; margin:0 auto; padding:20px 16px 60px }
  header { background:#0F2C44; color:#fff; border-radius:14px; padding:20px }
  header h1 { margin:0; font-size:21px; font-weight:800 }
  header p { margin:8px 0 0; opacity:.85; font-size:14px }
  .notice { margin-top:12px; padding:12px 14px; border-radius:10px; font-size:13.5px;
            background:rgba(255,255,255,.12) }
  .card { background:#fff; border:1px solid #DCE3E8; border-radius:14px;
          margin-top:22px; overflow:hidden }
  .card h2 { margin:0; padding:16px 18px 4px; font-size:16px; font-weight:800; color:#0F2C44 }
  .meta { padding:0 18px 14px; font-size:13px; color:#5B6874 }
  .subj { padding:10px 18px; background:#F4F8FA; border-top:1px solid #E5E9ED;
          border-bottom:1px solid #E5E9ED; font-size:13px; color:#5B6874 }
  .subj b { color:#0F2C44 }
  .frame { overflow:hidden; background:#fff }
  iframe { display:block; border:0; background:#fff; transform-origin:0 0 }
  footer { margin-top:26px; font-size:13px; color:#5B6874; text-align:center }
  code { background:#E2E8ED; padding:1px 5px; border-radius:4px; font-size:12.5px }
</style></head><body>
<div class="wrap">
  <header>
    <h1>What lands in the inbox</h1>
    <p>Three emails, rendered by the same code that sends them. The booking below is invented —
       Linda Harper does not exist.</p>
    ${notice ? `<div class="notice">${notice}</div>` : ''}
  </header>
  ${EMAILS.map(e => `
  <div class="card">
    <h2>${e.goesTo}</h2>
    <div class="meta">${e.when}</div>
    <div class="subj">Subject: <b>${e.subject.replace(/</g, '&lt;')}</b></div>
    <div class="frame"><iframe title="${e.key}" srcdoc="${e.html.replace(/"/g, '&quot;')}"></iframe></div>
  </div>`).join('')}
  <footer>Add <code>?send=1&amp;token=…</code> to mail all three to the team for real.</footer>
</div>
<script>
// Render each email at its natural width, then shrink it to fit — which is what
// Gmail does on a phone. Without this the 600px manifest is simply clipped, and
// the preview would look broken for a reason the real inbox does not have.
function fit() {
  document.querySelectorAll('.frame').forEach(box => {
    const f = box.querySelector('iframe'), d = f.contentDocument;
    if (!d || !d.body) return;
    f.style.width = '100%'; f.style.transform = '';
    const natural = Math.max(d.body.scrollWidth, 380);
    const avail = box.clientWidth;
    const scale = Math.min(1, avail / natural);
    f.style.width = natural + 'px';
    f.style.height = (d.body.scrollHeight + 28) + 'px';
    f.style.transform = 'scale(' + scale + ')';
    box.style.height = (d.body.scrollHeight + 28) * scale + 'px';
  });
}
addEventListener('resize', fit);
// Each srcdoc frame finishes on its own schedule, and a frame measured before
// its fonts land comes out short. Re-measure whenever one settles.
document.querySelectorAll('.frame iframe').forEach(f => {
  f.addEventListener('load', fit);
  try { new ResizeObserver(fit).observe(f.contentDocument.documentElement); } catch (e) {}
});
fit();
</script>
</body></html>`;

exports.handler = async (event) => {
  const q = event.queryStringParameters || {};

  if (q.send !== '1') {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
                 'X-Robots-Tag': 'noindex' },
      body: page(''),
    };
  }

  // ---- the real send ----
  const secret = process.env.PREVIEW_TOKEN;
  if (!secret) return { statusCode: 403, body: 'Set PREVIEW_TOKEN in Netlify before sending.' };
  if (q.token !== secret) return { statusCode: 403, body: 'Wrong token.' };

  const team = teamEmails();
  if (!process.env.RESEND_API_KEY) return { statusCode: 400, body: 'RESEND_API_KEY is not set.' };
  if (!team.length) return { statusCode: 400, body: 'TEAM_EMAILS is not set.' };

  // Everything goes to the team, including the guest copy — this is a rehearsal,
  // so no invented address is ever mailed.
  const sent = [], failed = [];
  for (const e of EMAILS) {
    try {
      await sendEmail({ to: team, subject: `[PREVIEW] ${e.subject}`, html: e.html });
      sent.push(e.key);
    } catch (err) {
      failed.push(`${e.key}: ${err.message}`);
    }
  }

  const ok = failed.length === 0;
  return {
    statusCode: ok ? 200 : 502,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    body: page(ok
      ? `Sent all three to ${team.length} ${team.length === 1 ? 'address' : 'addresses'}: ${team.join(', ')}.
         Check your inbox — and your spam folder, which is the honest test.`
      : `Sent: ${sent.join(', ') || 'none'}. <b>Failed:</b> ${failed.join(' · ')}`),
  };
};
