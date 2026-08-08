// GET /.netlify/functions/refusals?token=…             → the dashboard
// GET /.netlify/functions/refusals?token=…&format=json → the raw rows, for the weekly agent
// GET /.netlify/functions/refusals?token=…&month=2026-10
//
// The log holds no personal data, but it is commercially revealing — it says exactly how
// much demand the business turns away and where. So it is gated, and it renders itself
// rather than existing as a static page somebody could stumble onto.
//
// Reuses PREVIEW_TOKEN so there is nothing new to set up. If this ever needs sharing with
// someone who should not see the email previews, give it its own token.

const { listRefusals, monthKey, isConfigured } = require('./_refusals');

const COLOUR = {
  'Past the 9 AM cutoff':        '#C0392B',
  'Group over 40 people':        '#B8730A',
  'No vehicle left that day':    '#5B6B79',
  'Could not confirm a vehicle': '#7B4BC9',
  'Payment page failed to open': '#0F62D6',
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

const plain = (code, msg) => ({ statusCode: code,
  headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: msg });

function summarise(rows) {
  const by = (k) => rows.reduce((m, r) => {
    const v = r[k] || '—'; m[v] = m[v] || { n: 0, usd: 0 };
    m[v].n++; m[v].usd += r.wouldHavePaidUsd || 0; return m;
  }, {});
  // `at` arrives as 'YYYY-MM-DD HH:mm' already in Cozumel time, so read it literally —
  // handing it to Date() would drag it back through the server's timezone.
  const heat = Array.from({ length: 7 }, () => Array(8).fill(0));
  rows.forEach(r => {
    // Hour may be one or two digits — a cell that Sheets round-tripped through a date
    // format comes back as "2026-08-08 3:57", not "03:57", and a \d{2} here silently
    // dropped every row out of the heatmap while the totals above looked perfect.
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):/.exec(r.at || '');
    if (!m) return;
    const dow = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay();
    heat[dow][Math.floor(+m[4] / 3)]++;
  });
  return {
    count: rows.length,
    totalUsd: rows.reduce((n, r) => n + (r.wouldHavePaidUsd || 0), 0),
    paxTotal: rows.reduce((n, r) => n + (r.pax || 0), 0),
    byReason: by('reasonLabel'), byDestination: by('destinationName'), byShip: by('ship'), heat,
  };
}

exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  const want = process.env.PREVIEW_TOKEN;
  if (!want || q.token !== want) return plain(401, 'Add ?token=…');

  if (!isConfigured()) {
    return plain(503,
      'The refusal log has no home yet.\n\n' +
      'Deploy apps_script/cit_refusals/Code.gs as a web app (setup steps are at the top of\n' +
      'that file), then set REFUSALS_URL and REFUSALS_TOKEN in Netlify.\n\n' +
      'Refusals are already being detected — they are just not being written down.');
  }

  const month = /^\d{4}-\d{2}$/.test(q.month || '') ? q.month : monthKey();
  let data;
  try { data = await listRefusals(month); }
  catch (err) {
    console.error('refusals read failed', err);
    return plain(500, 'Could not read the refusal log: ' + (err && err.message));
  }

  const rows = data.records || [];
  const months = data.months && data.months.length ? data.months : [month];
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

  const bars = Object.entries(s.byReason).sort((a, b) => b[1].n - a[1].n).map(([label, v]) =>
    `<div class="rsn"><div class="top"><b>${esc(label)}</b>
      <span>${v.n} group${v.n === 1 ? '' : 's'} · ~$${v.usd.toLocaleString()}</span></div>
      <div class="track"><div class="fill" style="width:${(v.n / maxR * 100).toFixed(0)}%;
        background:${COLOUR[label] || '#5B6B79'}"></div></div></div>`
  ).join('') || '<p class="none">Nothing refused this month.</p>';

  const rank = (obj) => Object.entries(obj).sort((a, b) => b[1].n - a[1].n).slice(0, 8)
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td class="r">${v.n}</td><td class="r">$${v.usd.toLocaleString()}</td></tr>`)
    .join('') || '<tr><td colspan="3" class="none">Nothing yet.</td></tr>';

  let heat = '<div></div>' + DAYS.map(d => `<div class="hd">${d}</div>`).join('');
  HRS.forEach((lab, hi) => {
    heat += `<div class="rl">${lab}</div>`;
    DAYS.forEach((_, di) => {
      const v = s.heat[di][hi];
      heat += `<div class="cell" title="${DAYS[di]} ${lab} — ${v} refused" style="background:${
        v ? `rgba(192,57,43,${(0.13 + (v / maxH) * 0.72).toFixed(2)})` : '#EDF2F5'}"></div>`;
    });
  });

  const rowsHtml = rows.slice(0, 300).map(r => `<tr>
      <td class="mono">${esc(r.at)}</td>
      <td><span class="dot" style="background:${COLOUR[r.reasonLabel] || '#5B6B79'}"></span>${esc(r.reasonLabel)}</td>
      <td>${esc(r.destinationName || '—')}</td>
      <td class="r">${r.pax ?? '—'}</td>
      <td>${esc(r.wantedDate || '—')}</td>
      <td>${esc(r.ship || '—')}</td>
      <td class="r">${r.wouldHavePaidUsd ? '$' + r.wouldHavePaidUsd.toLocaleString() : '—'}</td>
    </tr>`).join('') || '<tr><td colspan="7" class="none">No refusals recorded for this month yet.</td></tr>';

  const picker = months.map(m =>
    `<a href="?token=${encodeURIComponent(q.token)}&month=${m}" class="${m === month ? 'on' : ''}">${m}</a>`).join('');
  const cutoffPct = s.count ? Math.round((s.byReason['Past the 9 AM cutoff']?.n || 0) / s.count * 100) : 0;

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
 .months a{font-size:13px;text-decoration:none;color:var(--mute);background:#fff;border:1px solid var(--line);border-radius:20px;padding:5px 12px}
 .months a.on{background:var(--accent);color:#fff;border-color:var(--accent)}
 .hero{background:#fff;border:1px solid var(--line);border-radius:14px;padding:20px 22px;margin-bottom:16px;display:flex;gap:26px;flex-wrap:wrap}
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
 .pb{padding:15px 18px;overflow-x:auto}
 .rsn{margin-bottom:14px}.rsn:last-child{margin-bottom:0}
 .rsn .top{display:flex;justify-content:space-between;font-size:13.5px;margin-bottom:5px;gap:12px}
 .rsn .top b{color:var(--navy);font-weight:600}.rsn .top span{color:var(--mute);white-space:nowrap}
 .track{height:9px;background:#EDF2F5;border-radius:5px;overflow:hidden}
 .fill{height:100%;border-radius:5px}
 .heat{display:grid;grid-template-columns:38px repeat(7,1fr);gap:3px;font-size:11px;min-width:340px}
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
<p>Every time a business rule turned a willing buyer away. All times Cozumel local.</p></div></header>
<div class="wrap">
 <div class="months">${picker}</div>
 <div class="hero">
   <div><div class="n">${s.count}</div><div class="l">groups turned away · ${month}</div></div>
   <div><div class="n m">$${s.totalUsd.toLocaleString()}</div><div class="l">estimated value, at your own price list</div></div>
   <div><div class="n">${s.paxTotal}</div><div class="l">passengers</div></div>
   <div><div class="n">${cutoffPct}%</div><div class="l">refused by the 9 AM cutoff alone</div></div>
 </div>
 <div class="grid">
   <div class="panel"><div class="ph"><h2>Why they were refused</h2><div class="s">Count and estimated value</div></div>
     <div class="pb">${bars}</div></div>
   <div class="panel"><div class="ph"><h2>When it happens</h2><div class="s">Day and hour — darker is worse</div></div>
     <div class="pb"><div class="heat">${heat}</div></div></div>
   <div class="panel"><div class="ph"><h2>Which destinations</h2></div><div class="pb">
     <table><thead><tr><th>Destination</th><th class="r">Groups</th><th class="r">Value</th></tr></thead>
     <tbody>${rank(s.byDestination)}</tbody></table></div></div>
   <div class="panel"><div class="ph"><h2>Which ships</h2></div><div class="pb">
     <table><thead><tr><th>Ship</th><th class="r">Groups</th><th class="r">Value</th></tr></thead>
     <tbody>${rank(s.byShip)}</tbody></table></div></div>
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
