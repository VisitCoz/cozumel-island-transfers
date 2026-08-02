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
const { manifestEmail, manifestSubject, guestEmail, guestSubject } = require('./_emails');

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
        subject: manifestSubject(date, runs),
        html: manifestEmail(date, runs),
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
        subject: guestSubject(r),
        html: guestEmail(r),
      });
      out.guests++;
    } catch (err) {
      console.error('manifest: guest email failed', r.ref, err);
      out.failed.push(r.ref);
    }
  }

  return json(200, out);
};
