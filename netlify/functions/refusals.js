// GET /.netlify/functions/refusals?token=…            → the dashboard
// GET /.netlify/functions/refusals?token=…&format=json → the raw rows, for an agent
// GET /.netlify/functions/refusals?token=…&month=2026-10
//
// The log holds no personal data, but it is commercially revealing — it says exactly how
// much demand the business turns away and where. So it is gated, and it renders itself
// rather than existing as a static page that could be found.
//
// Reuses PREVIEW_TOKEN so there is nothing new to set up. If this ever needs to be shared
// with someone who should not see the email previews, give it its own token.

const { listRefusals, refusalMonths, monthKey } = require('./_refusals');

const REASONS = {
  past_cutoff:          { label: 'Past the 9 AM cutoff',        colour: '#C0392B' },
  over_40:              { label: 'Group over 40 people',        colour: '#B8730A' },
  fleet_full:           { label: 'No vehicle left that day',    colour: '#5B6B79' },
  availability_unknown: { label: 'Could not confirm a vehicle', colour: '#7B4BC9' },
  payment_open_failed:  { label: 'Payment page failed to open', colour: '#0F62D6' },
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

function summarise(rows) {
  const by = (k) => rows.reduce((m, r) => {
    const v = r[k] || 'unknown'; m[v] = m[v] || { n: 0, usd: 0 };
    m[v].n++; m[v].usd += r.wouldHavePaidUsd || 0; return m;
  }, {});
  // Cozumel local day-of-week × 3-hour bucket, for the "when does this happen" heatmap.
  const heat = Array.from({ length: 7 }, () => Array(8).fill(0));
  rows.forEach(r => {
    const d = new Date(new Date(r.at).getTime() - 5 * 3600 * 1000);
    heat[d.getUTCDay()][Math.floor(d.getUTCHours() / 3)]++;
  });
  return {
    count: rows.length,
    totalUsd: rows.reduce((n, r) => n + (r.wouldHavePaidUsd || 0), 0),
    paxTotal: rows.reduce((n, r) => n + (r.pax || 0), 0),
    byReason: by('reason'), byDestination: by('destinationName'), byShip: by('ship'), heat,
  };
}

exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  const want = process.env.PREVIEW_TOKEN;
  if (!want || q.token !== want) {
    return { statusCode: 401, headers: { 'Content-Type': 'text/plain' }, body: 'Add ?token=…' };
  }

  const month = /^\d{4}-\d{2}$/.test(q.month || '') ? q.month : monthKey();
  let rows = [], months = [];
  try {
    rows = await listRefusals(month);
    months = await refusalMonths();
  } catch (err) {
    console.error('refusals read failed', err);
    return { statusCode: 500, headers: { 'Content-Type': 'text/plain' },
      body: 'Could not read the refusal log: ' + (err && err.message) };
  }
  const s = summarise(rows);

  if (q.format === 'json') {
    return { statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ month, months, summary: s, records: rows }, null, 2) };
  }

  const maxR = Math.max(1, ...Object.values(s.byReason).map(v => v.n));
  const maxH = Math.max(1, ...s.heat.flat());
  const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const HRS  = ['12am','3am','6am','9am','12pm','3pm','6pm','9pm'];

  const bars = Object.entries(s.byReason)
    .sort((a, b) => b[1].n - a[1].n)
    .map(([k, v]) => {
      const r = REASONS[k] || { label: k, colour: '#5B6B79' };
      return `<div class="rsn"><div class="top"><b>${esc(r.label)}</b>
        <span>${v.n} group${v.n === 1 ? '' : 's'} · ~$${v.usd.toLocaleString()}</span></div>
        <div class="track"><div class="fill" style="width:${(v.n / maxR * 100).toFixed(0)}%;background:${r.colour}"></div></div></div>`;
    }).join('') || '<p class="none">Nothing refused this month.</p>';

  const rank = (obj, empty) => Object.entries(obj).sort((a, b) => b[1].n - a[1].n).slice(0, 8)
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td class="r">${v.n}</td><td class="r">$${v.usd.toLocaleString()}</td></tr>`)
    .join('') || `<tr><td colspan="3" class="none">${empty}</td></tr>`;

  let heat = '<div></div>' + DAYS.map(d => `<div class="hd">${d}</div>`).join('');
  HRS.forEach((lab, hi) => {
    heat += `<div class="rl">${lab}</div>`;
    DAYS.forEach((_, di) => {
      const v = s.heat[di][hi];
      heat += `<div class="cell" title="${DAYS[di]} ${lab} — ${v} refused"
        style="background:${v ? `rgba(192,57,43,${(0.13 + (v / maxH) * 0.72).toFixed(2)})` : '#EDF2F5'}"></div>`;
    });
  });

  const rowsHtml = rows.slice(0, 200).map(r => {
    const rr = REASONS[r.reason] || { label: r.reason, colour: '#5B6B79' };
    const at = new Date(new Date(r.at).getTime() - 5 * 3600 * 1000);
    return `<tr>
      <td class="mono">${at.toISOString().slice(0, 16).replace('T', ' ')}</td>
      <td><span class="dot" style="background:${rr.colour}"></span>${esc(rr.label)}</td>
      <td>${esc(r.destinationName || r.destination || '—')}</td>
      <td class="r">${r.pax ?? '—'}</td>
      <td>${esc(r.wantedDate || '—')}</td>
      <td>${esc(r.ship || '—')}</td>
      <td class="r">${r.wouldHavePaidUsd ? '$' + r.wouldHavePaidUsd.toLocaleString() : '—'}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="7" class="none">No refusals recorded for this month yet.</td></tr>';

  const picker = (months.length ? months : [month]).map(m =>
    `<a href="?token=${encodeURIComponent(q.token)}&month=${m}" class="${m === month ? 'on' : ''}">${m}</a>`).join('');

  return { statusCode: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
               'X-Robots-Tag': 'noindex, nofollow' },
    body: `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Lost Demand · ${month}</title>
<style>
 :root{--navy:#0F2C44;--accent:#0F62D6;--ink:#16232E;--mute:#5B6B79;--line:#DDE5EB;--bg:#F4F8FA;--bad:#C0392B}
 *{box-sizing:border-box}
 body{margin:0;background:var(--bg);color:var(--ink);font:400 15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Helvetica,Arial,sans-serif}
 header{background:var(--navy);color:#fff}
 header .in{max-width:1000px;margin:0 auto;padding:24px 20px 20px}
 .kick{font-size:12px;letter-spacing:.07em;color:#8FB4CE;margin-bottom:6px}
 h1{font-size:23px;font-weight:600;margin:0 0 4px}
 header p{margin:0;color:#C6D8E5;font-size:14px}
 .wrap{max-width:1000px;margin:0 auto;padding:20px 20px 70px}
 .months{display:flex;gap:7px;flex-wrap:wrap;margin-bottom:16px}
 .months a{font-size:13px;text-decoration:none;color:var(--mute);background:#fff;border:1px solid var(--line);
   border-radius:20px;padding:5px 12px}
 .months a.on{background:var(--accent);color:#fff;border-color:var(--accent)}
 .hero{background:#fff;border:1px solid var(--line);border-radius:14px;padding:20px 22px;margin-bottom:16px;
   display:flex;gap:26px;flex-wrap:wrap}
 .hero div{flex:1;min-width:158px}
 .hero .n{font-size:38px;font-weight:700;color:var(--navy);line-height:1}
 .hero .n.m{color:var(--bad)}
 .hero .l{font-size:13.5px;color:var(--mute);margin-top:4px}
 .grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
 @media(max-width:820px){.grid{grid-template-columns:1fr}}
 .panel{background:#fff;border:1px solid var(--line);border-radius:14px;overflow:hidden}
 .panel.full{grid-column:1/-1}
 .ph{padding:12px 18px;border-bottom:1px solid var(--line)}
 .ph h2{margin:0;font-size:14px;font-weight:600;color:var(--navy)}
 .ph .s{font-size:12.5px;color:var(--mute);margin-top:2px}
 .pb{padding:15px 18px}
 .rsn{margin-bottom:14px}.rsn:last-child{margin-bottom:0}
 .rsn .top{display:flex;justify-content:space-between;font-size:13.5px;margin-bottom:5px;gap:12px}
 .rsn .top b{color:var(--navy);font-weight:600}.rsn .top span{color:var(--mute);white-space:nowrap}
 .track{height:9px;background:#EDF2F5;border-radius:5px;overflow:hidden}
 .fill{height:100%;border-radius:5px}
 .heat{display:grid;grid-template-columns:38px repeat(7,1fr);gap:3px;font-size:11px}
 .heat .hd{color:#9AA9B6;text-align:center;padding-bottom:3px}
 .heat .rl{color:#9AA9B6;text-align:right;padding-right:5px;line-height:20px}
 .cell{height:20px;border-radius:4px}
 table{width:100%;border-collapse:collapse;font-size:13.5px}
 th{text-align:left;font-weight:600;color:var(--mute);font-size:12px;padding:0 10px 8px 0;border-bottom:1px solid var(--line)}
 td{padding:9px 10px 9px 0;border-bottom:1px solid #EDF2F5}
 td.r,th.r{text-align:right}
 .mono{font:500 12.5px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--mute);white-space:nowrap}
 .dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:7px}
 .none{color:var(--mute);text-align:center;padding:18px 0}
 .foot{font-size:13px;color:var(--mute);margin-top:18px;max-width:76ch}
 code{font:500 12.5px ui-monospace,Menlo,monospace;background:#E7EEF3;padding:2px 6px;border-radius:4px}
</style></head><body>
<header><div class="in"><div class="kick">COZUMEL ISLAND TRANSFERS · INTERNAL</div>
<h1>Lost Demand — the bookings you didn't get</h1>
<p>Every time a business rule turned a willing buyer away. Cozumel local time.</p></div></header>
<div class="wrap">
 <div class="months">${picker}</div>
 <div class="hero">
   <div><div class="n">${s.count}</div><div class="l">groups turned away · ${month}</div></div>
   <div><div class="n m">$${s.totalUsd.toLocaleString()}</div><div class="l">estimated value, at your own price list</div></div>
   <div><div class="n">${s.paxTotal}</div><div class="l">passengers</div></div>
   <div><div class="n">${s.count ? Math.round((s.byReason.past_cutoff?.n || 0) / s.count * 100) : 0}%</div>
        <div class="l">refused by the 9 AM cutoff alone</div></div>
 </div>
 <div class="grid">
   <div class="panel"><div class="ph"><h2>Why they were refused</h2><div class="s">Count and estimated value</div></div>
     <div class="pb">${bars}</div></div>
   <div class="panel"><div class="ph"><h2>When it happens</h2><div class="s">Day and hour, Cozumel time — darker is worse</div></div>
     <div class="pb"><div class="heat">${heat}</div></div></div>
   <div class="panel"><div class="ph"><h2>Which destinations</h2></div><div class="pb">
     <table><thead><tr><th>Destination</th><th class="r">Groups</th><th class="r">Value</th></tr></thead>
     <tbody>${rank(s.byDestination, 'Nothing yet.')}</tbody></table></div></div>
   <div class="panel"><div class="ph"><h2>Which ships</h2></div><div class="pb">
     <table><thead><tr><th>Ship</th><th class="r">Groups</th><th class="r">Value</th></tr></thead>
     <tbody>${rank(s.byShip, 'Nothing yet.')}</tbody></table></div></div>
   <div class="panel full"><div class="ph"><h2>Every refusal</h2>
     <div class="s">Newest first. No name, no email, no phone — nothing personal is stored.</div></div>
     <div class="pb"><table><thead><tr><th>When</th><th>Reason</th><th>Destination</th>
       <th class="r">Pax</th><th>Wanted</th><th>Ship</th><th class="r">Value</th></tr></thead>
       <tbody>${rowsHtml}</tbody></table></div></div>
 </div>
 <p class="foot">Add <code>&amp;format=json</code> for the raw rows — that is what the weekly
   agent reads. Estimated value uses the list price of the vehicle the group needed; for groups
   over 40 it assumes the buses they would have taken.</p>
</div></body></html>` };
};
