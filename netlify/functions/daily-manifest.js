// Scheduled daily — see netlify.toml. Runs at 23:00 UTC = 6 PM Cozumel time.
//
// Two jobs, both built from tomorrow's bookings:
//   1. A manifest to the team — the whole day on one screen, sorted by pickup.
//   2. One email per guest with the meeting point and their times.
//
// There is no database. Every booking carries its date in Stripe metadata, so
// Stripe's own search is the query layer.
//
// Safe to run twice: it only reads and sends. If it double-fires, guests get a
// duplicate reminder — annoying, not damaging. That is the right failure to
// choose over a job that silently skips a day.

const { json, bookingsOn, tomorrowInCozumel, minutesOf, sendEmail, teamEmails } = require('./_cit');

const WHATSAPP = '+52 987 114 6853';
const esc = (s) => String(s ?? '').replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

const prettyDate = (iso) => new Date(iso + 'T12:00:00Z')
  .toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });

function manifestHtml(date, runs) {
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

function guestHtml(r) {
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

exports.handler = async () => {
  const date = process.env.MANIFEST_DATE_OVERRIDE || tomorrowInCozumel();

  let runs;
  try {
    runs = await bookingsOn(date);
  } catch (err) {
    console.error('manifest: could not read bookings', err);
    return json(500, { error: String(err) });
  }

  runs.sort((a, b) => minutesOf(a.pickup) - minutesOf(b.pickup));

  // A quiet day is not a failure — say nothing rather than emailing "0 runs".
  if (!runs.length) return json(200, { date, runs: 0, sent: false });

  const team = teamEmails();
  const out = { date, runs: runs.length, team: 0, guests: 0, failed: [] };

  if (process.env.RESEND_API_KEY && team.length) {
    try {
      await sendEmail({
        to: team,
        subject: `Tomorrow · ${prettyDate(date)} · ${runs.length} runs`,
        html: manifestHtml(date, runs),
      });
      out.team = team.length;
    } catch (err) {
      console.error('manifest: team email failed', err);
      out.failed.push('team');
    }
  }

  // One at a time, so a single bad address can't stop the rest going out.
  for (const r of runs) {
    if (!r.email || !process.env.RESEND_API_KEY) continue;
    try {
      await sendEmail({
        to: r.email,
        subject: `Tomorrow: your transfer to ${r.destination} — where to find us`,
        html: guestHtml(r),
      });
      out.guests++;
    } catch (err) {
      console.error('manifest: guest email failed', r.ref, err);
      out.failed.push(r.ref);
    }
  }

  return json(200, out);
};
