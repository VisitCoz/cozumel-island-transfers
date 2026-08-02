// Every email this system sends, in one file.
//
// These bodies used to live inside stripe-webhook.js and daily-manifest.js.
// They are here so the preview page renders the REAL email rather than a copy
// of it — a preview that can drift from what actually sends is worse than no
// preview at all, because it teaches you to trust something untested.

const WHATSAPP = '+52 987 114 6853';

const esc = (s) => String(s ?? '').replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

const prettyDate = (iso) => new Date(iso + 'T12:00:00Z')
  .toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });

// ---------- 1. A booking just came in → the team ----------
function bookingEmail(m, amount, currency, email) {
  const wa = String(m.whatsapp || '').replace(/[^0-9]/g, '');
  const row = (k, v) => v
    ? `<tr><td style="padding:7px 0;color:#6E6E73;width:38%">${k}</td>
           <td style="padding:7px 0;color:#0F2C44;font-weight:600">${esc(v)}</td></tr>`
    : '';
  return `
  <div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:520px;
              margin:0 auto;color:#0E0E10;line-height:1.5">
    <div style="background:#0F2C44;color:#fff;padding:18px 20px;border-radius:12px 12px 0 0">
      <div style="font-size:11px;letter-spacing:.12em;text-transform:uppercase;opacity:.7">New booking</div>
      <div style="font-size:21px;font-weight:800;margin-top:4px">
        ${esc(m.destination_name || m.destination)} · ${esc(m.date)}</div>
      <div style="opacity:.8;font-size:14px;margin-top:2px">
        ${esc(m.pickup)} – ${esc(m.ret)} · ${esc(m.pax)} people</div>
    </div>
    <div style="border:1px solid #E5E5E7;border-top:none;border-radius:0 0 12px 12px;padding:16px 20px">
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        ${row('Guest', m.guest)}
        ${row('Email', email)}
        ${row('WhatsApp', m.whatsapp)}
        ${row('Ship', m.ship)}
        ${row('Vehicle', m.vehicle_name || m.vehicle)}
        ${row('Paid', `$${amount.toFixed(2)} ${currency}`)}
        ${row('Admission prepaid', m.admission_prepaid === 'true' ? 'Yes' : 'No')}
        ${row('Reference', m.booking_ref)}
      </table>
      ${wa ? `<a href="https://wa.me/${wa}"
        style="display:inline-block;margin-top:14px;background:#1F7A3F;color:#fff;text-decoration:none;
               padding:11px 18px;border-radius:10px;font-weight:700;font-size:14px">
        Message ${esc(m.guest || 'the guest')} on WhatsApp</a>` : ''}
    </div>
  </div>`;
}

const bookingSubject = (m) =>
  `Booking · ${m.destination_name || m.destination} · ${m.date} · ${m.pax} pax`;

// ---------- 2. The evening before → the team ----------
function manifestEmail(date, runs) {
  const rows = runs.map(r => `
    <tr style="border-top:1px solid #E5E5E7">
      <td style="padding:10px 8px 10px 0;font-weight:800;color:#0F2C44;white-space:nowrap">${esc(r.pickup)}</td>
      <td style="padding:10px 8px">
        <div style="font-weight:700;color:#0F2C44">${esc(r.destination)}</div>
        <div style="font-size:12.5px;color:#6E6E73">${esc(r.guest)} · ${r.pax} pax · ${esc(r.vehicle)}</div>
        <div style="font-size:12.5px;color:#6E6E73">${esc(r.ship)}</div>
      </td>
      <td style="padding:10px 0;text-align:right;white-space:nowrap">
        <div style="font-size:12.5px;color:#6E6E73">back ${esc(r.ret)}</div>
        <div style="font-size:11.5px;color:#8C9AAB">${esc(r.ref)}</div>
      </td>
    </tr>`).join('');

  const pax = runs.reduce((n, r) => n + r.pax, 0);
  return `
  <div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:600px;
              margin:0 auto;color:#0E0E10;line-height:1.5">
    <div style="background:#0F2C44;color:#fff;padding:18px 20px;border-radius:12px 12px 0 0">
      <div style="font-size:11px;letter-spacing:.12em;text-transform:uppercase;opacity:.7">Tomorrow</div>
      <div style="font-size:22px;font-weight:800;margin-top:4px">${esc(prettyDate(date))}</div>
      <div style="opacity:.8;font-size:14px;margin-top:2px">
        ${runs.length} ${runs.length === 1 ? 'run' : 'runs'} · ${pax} passengers</div>
    </div>
    <div style="border:1px solid #E5E5E7;border-top:none;border-radius:0 0 12px 12px;padding:6px 20px 18px">
      <table style="width:100%;border-collapse:collapse;font-size:14px">${rows}</table>
      <p style="font-size:12.5px;color:#6E6E73;margin:16px 0 0">
        Every guest on this list has been emailed the meeting point and their times.
        Drivers are not assigned by this message.</p>
    </div>
  </div>`;
}

const manifestSubject = (date, runs) =>
  `Tomorrow · ${prettyDate(date)} · ${runs.length} runs`;

// ---------- 3. The evening before → each guest ----------
// Meeting point and times only. No driver name, no vehicle, no plate — so
// nothing has to be assigned a day ahead just to send this.
function guestEmail(r) {
  return `
  <div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:520px;
              margin:0 auto;color:#0E0E10;line-height:1.55">
    <div style="background:#0F2C44;color:#fff;padding:20px;border-radius:12px 12px 0 0">
      <div style="font-size:11px;letter-spacing:.12em;text-transform:uppercase;opacity:.7">Tomorrow in Cozumel</div>
      <div style="font-size:21px;font-weight:800;margin-top:4px">Where to find us</div>
    </div>
    <div style="border:1px solid #E5E5E7;border-top:none;border-radius:0 0 12px 12px;padding:20px">
      <p style="margin:0 0 14px">Hello${r.guest ? ' ' + esc(r.guest.split(' ')[0]) : ''},</p>
      <p style="margin:0 0 16px">Your transfer to <b>${esc(r.destination)}</b> is tomorrow. Here is
        everything you need.</p>

      <div style="background:#F4F8FA;border:1px solid #E5E5E7;border-radius:10px;padding:14px 16px">
        <div style="font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#8C9AAB">Where</div>
        <p style="margin:5px 0 0">Walk out of the cruise terminal. Our representative is at our marked
          meeting point <b>a few steps outside</b>, holding a sign with your name on it.</p>
      </div>

      <table style="width:100%;border-collapse:collapse;font-size:15px;margin-top:16px">
        <tr><td style="padding:8px 0;color:#6E6E73">We pick you up</td>
            <td style="padding:8px 0;text-align:right;font-weight:800;color:#0F2C44">${esc(r.pickup)}</td></tr>
        <tr style="border-top:1px solid #E5E5E7"><td style="padding:8px 0;color:#6E6E73">We come back for you</td>
            <td style="padding:8px 0;text-align:right;font-weight:800;color:#0F2C44">${esc(r.ret)}</td></tr>
      </table>
      <p style="font-size:12.5px;color:#6E6E73;margin:6px 0 0">
        Both times are <b>Cozumel local time</b> (UTC−5) — not your ship's onboard clock.
        Many ships run an hour ahead.</p>

      <div style="margin-top:18px;padding-top:16px;border-top:1px solid #E5E5E7">
        <p style="margin:0 0 4px">Anything at all, message us on WhatsApp — we answer in English.</p>
        <div style="font-size:19px;font-weight:800;color:#0F2C44">${WHATSAPP}</div>
        <p style="font-size:12.5px;color:#6E6E73;margin:8px 0 0">
          Your booking reference is <b>${esc(r.ref)}</b>. Nothing to pay the driver.</p>
      </div>
    </div>
  </div>`;
}

const guestSubject = (r) => `Tomorrow: your transfer to ${r.destination} — where to find us`;

module.exports = {
  WHATSAPP, esc, prettyDate,
  bookingEmail, bookingSubject,
  manifestEmail, manifestSubject,
  guestEmail, guestSubject,
};
