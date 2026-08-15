// POST /.netlify/functions/funnel                       ← the browser beacon, one step
// GET  /.netlify/functions/funnel?token=…                → the dashboard
// GET  /.netlify/functions/funnel?token=…&format=json    → raw rows, for a weekly agent
// GET  /.netlify/functions/funnel?token=…&month=2026-09
//
// The POST side is deliberately open — it is called by every visitor's browser, so it
// cannot be gated. It is safe to leave open because it stores nothing personal and nothing
// that costs money: the worst an abuser achieves is junk rows in a spreadsheet. Everything
// that arrives is validated against a fixed step list and truncated before it is written.
//
// The GET side is gated. The funnel is commercially revealing — it says exactly where the
// business loses people — so it reuses PREVIEW_TOKEN, same as the refusal dashboard.

const { logStep, listSteps, monthKey, isConfigured, STEPS, STEP_LABEL } = require('./_funnel');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

const plain = (code, msg) => ({ statusCode: code,
  headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: msg });

/* ── the beacon ────────────────────────────────────────────────────────────── */
async function record(event) {
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 204, body: '' }; }

  // 204 whatever happens. The browser sent this with sendBeacon and is not listening;
  // an error status would only ever show up as noise in somebody's console.
  if (isConfigured()) await logStep(body);
  else console.warn('funnel not configured — set FUNNEL_URL / FUNNEL_TOKEN');

  return { statusCode: 204, headers: { 'Cache-Control': 'no-store' }, body: '' };
}

/* ── the dashboard ─────────────────────────────────────────────────────────── */
function summarise(rows) {
  // One session may write the same step twice if two tabs race. Count distinct sessions
  // per step, never raw rows, or a single indecisive visitor inflates the whole funnel.
  const seen = {};                     // step -> Set(sid)
  const sessions = new Set();
  const bySource = {}, byDest = {};

  for (const r of rows) {
    if (!r.step || !r.sid) continue;
    // Verifying this chain end to end means POSTing a whole session, including 'done'.
    // Left in, that reads as a booking nobody made and quietly overstates conversion —
    // the one number here that must never flatter itself. Any check that walks the funnel
    // should send source 'end-to-end-test' so its rows stay in the sheet but out of the maths.
    if (r.source === 'end-to-end-test') continue;
    (seen[r.step] = seen[r.step] || new Set()).add(r.sid);
    sessions.add(r.sid);
    if (r.step === 'land') {
      const s = r.source || 'direct';
      bySource[s] = (bySource[s] || 0) + 1;
    }
    if (r.step === 'dest' && r.dest) byDest[r.dest] = (byDest[r.dest] || 0) + 1;
  }

  const counts = STEPS.map(s => ({ step: s, label: STEP_LABEL[s] || s, n: (seen[s] || new Set()).size }));
  const top = counts[0].n || 0;

  // Drop-off is measured against the previous step that actually had traffic. Measuring
  // against the step immediately before would report a meaningless 0% whenever a step is
  // skipped — the hero configurator lets a guest answer 'pax' before 'hub', for instance.
  let prev = null;
  for (const c of counts) {
    c.pctOfTop = top ? Math.round(c.n / top * 100) : 0;
    c.lost = prev === null ? null : Math.max(0, prev - c.n);
    c.lostPct = prev ? Math.round(Math.max(0, prev - c.n) / prev * 100) : null;
    if (c.n > 0) prev = c.n;
  }

  // The single most useful number on the page: the biggest single leak.
  const leaks = counts.filter(c => c.lost !== null && c.lost > 0)
    .sort((a, b) => b.lost - a.lost);

  return { counts, sessions: sessions.size, top, bySource, byDest, worst: leaks[0] || null };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'POST') return record(event);
  if (event.httpMethod !== 'GET') return plain(405, 'GET or POST');

  const q = event.queryStringParameters || {};
  const want = process.env.PREVIEW_TOKEN;
  if (!want || q.token !== want) return plain(401, 'Add ?token=…');

  if (!isConfigured()) {
    return plain(503,
      'The funnel has no home yet.\n\n' +
      'Deploy apps_script/cit_funnel/Code.gs as a web app (setup steps are at the top of\n' +
      'that file), then set FUNNEL_URL and FUNNEL_TOKEN in Netlify.\n\n' +
      'The beacon is already firing from the site — the steps are just not being written down.');
  }

  const month = /^\d{4}-\d{2}$/.test(q.month || '') ? q.month : monthKey();
  let data;
  try { data = await listSteps(month); }
  catch (err) {
    console.error('funnel read failed', err);
    return plain(500, 'Could not read the funnel: ' + (err && err.message));
  }

  const rows = data.records || [];
  const months = data.months && data.months.length ? data.months : [month];
  const s = summarise(rows);

  if (q.format === 'json') {
    return { statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ month, months, summary: s, records: rows }, null, 2) };
  }

  const bars = s.counts.map(c => `
    <div class="stp">
      <div class="top"><b>${esc(c.label)}</b>
        <span>${c.n} ${c.n === 1 ? 'visitor' : 'visitors'}${
          c.pctOfTop && c.step !== 'land' ? ` · ${c.pctOfTop}% of arrivals` : ''}</span></div>
      <div class="track"><div class="fill" style="width:${
        s.top ? Math.max(c.n / s.top * 100, c.n ? 1.5 : 0).toFixed(1) : 0}%"></div></div>
      ${c.lost ? `<div class="drop">▼ ${c.lost} left here${
        c.lostPct ? ` — ${c.lostPct}% of the ones who got this far` : ''}</div>` : ''}
    </div>`).join('');

  const rank = (obj, empty) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td class="r">${v}</td></tr>`).join('')
    || `<tr><td colspan="2" class="none">${empty}</td></tr>`;

  const picker = months.map(m =>
    `<a href="?token=${encodeURIComponent(q.token)}&month=${m}" class="${m === month ? 'on' : ''}">${m}</a>`).join('');

  const booked = s.counts.find(c => c.step === 'done');
  const convPct = s.top && booked ? (booked.n / s.top * 100).toFixed(1) : '0.0';

  return { statusCode: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
               'X-Robots-Tag': 'noindex, nofollow' },
    body: `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Booking funnel · ${month}</title>
<style>
 :root{--navy:#0F2C44;--accent:#0F62D6;--ink:#16232E;--mute:#5B6B79;--line:#DDE5EB;--bg:#F4F8FA;--bad:#C0392B;--good:#1E7A4F}
 *{box-sizing:border-box}
 body{margin:0;background:var(--bg);color:var(--ink);font:400 15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Helvetica,Arial,sans-serif}
 header{background:var(--navy);color:#fff}
 header .in{max-width:1000px;margin:0 auto;padding:24px 20px 20px}
 .kick{font-size:12px;letter-spacing:.07em;color:#8FB4CE;margin-bottom:6px}
 h1{font-size:23px;font-weight:600;margin:0 0 4px}
 header p{margin:0;color:#C6D8E5;font-size:14px}
 .wrap{max-width:1000px;margin:0 auto;padding:20px 20px 70px}
 .months{display:flex;gap:7px;flex-wrap:wrap;margin-bottom:16px}
 .months a{font-size:13px;text-decoration:none;color:var(--mute);background:#fff;border:1px solid var(--line);border-radius:20px;padding:5px 12px}
 .months a.on{background:var(--accent);color:#fff;border-color:var(--accent)}
 .hero{background:#fff;border:1px solid var(--line);border-radius:14px;padding:20px 22px;margin-bottom:16px;display:flex;gap:26px;flex-wrap:wrap}
 .hero div{flex:1;min-width:158px}
 .hero .n{font-size:38px;font-weight:700;color:var(--navy);line-height:1}
 .hero .n.g{color:var(--good)} .hero .n.m{color:var(--bad)}
 .hero .l{font-size:13.5px;color:var(--mute);margin-top:4px}
 .grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
 @media(max-width:820px){.grid{grid-template-columns:1fr}}
 .panel{background:#fff;border:1px solid var(--line);border-radius:14px;overflow:hidden}
 .panel.full{grid-column:1/-1}
 .ph{padding:12px 18px;border-bottom:1px solid var(--line)}
 .ph h2{margin:0;font-size:14px;font-weight:600;color:var(--navy)}
 .ph .s{font-size:12.5px;color:var(--mute);margin-top:2px}
 .pb{padding:15px 18px;overflow-x:auto}
 .stp{margin-bottom:16px}.stp:last-child{margin-bottom:0}
 .stp .top{display:flex;justify-content:space-between;font-size:13.5px;margin-bottom:5px;gap:12px}
 .stp .top b{color:var(--navy);font-weight:600}.stp .top span{color:var(--mute);white-space:nowrap}
 .track{height:11px;background:#EDF2F5;border-radius:6px;overflow:hidden}
 .fill{height:100%;border-radius:6px;background:linear-gradient(90deg,#0F62D6,#2E8BE6)}
 .drop{font-size:12.5px;color:var(--bad);margin-top:4px}
 table{width:100%;border-collapse:collapse;font-size:13.5px}
 th{text-align:left;font-weight:600;color:var(--mute);font-size:12px;padding:0 10px 8px 0;border-bottom:1px solid var(--line)}
 td{padding:9px 10px 9px 0;border-bottom:1px solid #EDF2F5}
 td.r,th.r{text-align:right}
 .none{color:var(--mute);text-align:center;padding:18px 0}
 .foot{font-size:13px;color:var(--mute);margin-top:18px;max-width:76ch}
 code{font:500 12.5px ui-monospace,Menlo,monospace;background:#E7EEF3;padding:2px 6px;border-radius:4px}
</style></head><body>
<header><div class="in"><div class="kick">COZUMEL ISLAND TRANSFERS · INTERNAL</div>
<h1>Booking funnel — where they stop</h1>
<p>One visit counted once per step. No cookies, no personal data. All times Cozumel local.</p></div></header>
<div class="wrap">
 <div class="months">${picker}</div>
 <div class="hero">
   <div><div class="n">${s.top}</div><div class="l">arrived · ${month}</div></div>
   <div><div class="n g">${booked ? booked.n : 0}</div><div class="l">booked</div></div>
   <div><div class="n">${convPct}%</div><div class="l">of arrivals became a booking</div></div>
   <div><div class="n m">${s.worst ? s.worst.lost : 0}</div>
     <div class="l">${s.worst ? 'biggest single leak — ' + esc(s.worst.label.toLowerCase()) : 'no leak yet'}</div></div>
 </div>
 <div class="panel full"><div class="ph"><h2>The funnel</h2>
   <div class="s">Each bar is the number of visits that ever reached that step. Going back does not count twice.</div></div>
   <div class="pb">${bars}</div></div>
 <div class="grid" style="margin-top:16px">
   <div class="panel"><div class="ph"><h2>Where they came from</h2></div><div class="pb">
     <table><thead><tr><th>Source</th><th class="r">Visits</th></tr></thead>
     <tbody>${rank(s.bySource, 'Nothing yet.')}</tbody></table></div></div>
   <div class="panel"><div class="ph"><h2>Which destination they chose</h2></div><div class="pb">
     <table><thead><tr><th>Destination</th><th class="r">Visits</th></tr></thead>
     <tbody>${rank(s.byDest, 'Nobody has picked one yet.')}</tbody></table></div></div>
 </div>
 <p class="foot">Add <code>&amp;format=json</code> for the raw rows. Traffic, countries and
   referrers live in Cloudflare Web Analytics; this page answers the different question of
   how far into the booking each visit got. A step showing more visits than the one above it
   means guests are skipping ahead from the hero configurator, which is working as designed.</p>
</div></body></html>` };
};
