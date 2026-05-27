// Cozumel ship schedule — pulls from APIQROO (official port authority).
// Source: https://servicios.apiqroo.com.mx/programacion/
// APIQROO updates the page every Sunday. We cache for 6h at edge.

const SOURCE = 'https://servicios.apiqroo.com.mx/programacion/';

const MONTHS_ES = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];

exports.handler = async () => {
  try {
    const res = await fetch(SOURCE, { headers: { 'User-Agent': 'Mozilla/5.0 (CIT ships widget)' } });
    if (!res.ok) throw new Error(`source ${res.status}`);
    const html = await res.text();
    const ships = parseShips(html);

    // Today in America/Cancun (UTC-5, no DST). Use a fixed offset.
    const now = new Date();
    const cancunMs = now.getTime() + now.getTimezoneOffset() * 60000 - 5 * 3600000;
    const today = isoDate(new Date(cancunMs));
    const tomorrow = isoDate(addDays(new Date(cancunMs), 1));

    const todayShips = ships.filter(s => s.dateISO === today);
    const tomorrowShips = ships.filter(s => s.dateISO === tomorrow);

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=21600, s-maxage=21600',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({
        source: 'apiqroo.com.mx',
        sourceUrl: SOURCE,
        fetchedAt: new Date().toISOString(),
        today: { date: today, ships: todayShips },
        tomorrow: { date: tomorrow, ships: tomorrowShips }
      })
    };
  } catch (e) {
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({ error: e.message, fallback: true })
    };
  }
};

function parseShips(html) {
  const ships = [];
  const rowRx = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  let currentDate = null;
  let m;
  while ((m = rowRx.exec(html))) {
    const row = m[1];

    // Date header: <td colspan="8" class="subtitle">…<b>…01 de may de 2026</b></td>
    const dateMatch = row.match(/colspan="8"[\s\S]*?<b>[\s\S]*?(\d{1,2}) de (\w+) de (\d{4})/i);
    if (dateMatch) {
      const day = dateMatch[1].padStart(2, '0');
      const monthIdx = MONTHS_ES.indexOf(dateMatch[2].toLowerCase());
      const year = dateMatch[3];
      if (monthIdx >= 0) {
        currentDate = `${year}-${String(monthIdx + 1).padStart(2, '0')}-${day}`;
      }
      continue;
    }
    if (!currentDate) continue;

    // Ship row fields
    const port = pick(row, /data-title="PUERTO">[\s\S]*?<div>([^<]+)<\/div>/);
    const country = pick(row, /data-title="PA[ÍI]S"[\s\S]*?<span>([^<]+)<\/span>/);
    const ship = pick(row, /data-title="CRUCERO">([^<]+)/);
    const etaArr = [...row.matchAll(/data-title="ETA">([^<]+)/g)];
    const etdArr = [...row.matchAll(/data-title="ETD">([^<]+)/g)];
    const statusMatch = row.match(/circle_(\w+)\.png/);
    const eta = etaArr[0]?.[1]?.trim() || '';
    const etd = etdArr[0]?.[1]?.trim() || '';
    const status = statusMatch ? statusMatch[1] : 'scheduled';

    if (ship) {
      ships.push({
        dateISO: currentDate,
        port: cleanPort(port),
        country: (country || '').trim(),
        ship: ship.trim(),
        eta, etd, status
      });
    }
  }
  return ships;
}

function pick(s, rx) {
  const m = s.match(rx);
  return m ? m[1] : null;
}

function cleanPort(p) {
  if (!p) return '';
  return p.replace(/^TERMINAL\s+/i, '').trim();
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function addDays(d, n) {
  const r = new Date(d);
  r.setUTCDate(r.getUTCDate() + n);
  return r;
}
