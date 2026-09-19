// The Google Maps browser key, and nothing else.
//
// Why a function for one string: a Maps *browser* key is public by nature — it goes
// into a <script src> the guest can read — but it still must not live in this
// repository, because the repository is public and a key committed once is a key
// rotated forever. So it lives in exactly one place, the Netlify environment
// variable GOOGLE_MAPS_BROWSER_KEY, and this endpoint hands it to the page at
// request time.
//
// 🚨 THE VARIABLE IS NOT SET YET, AND THE SITE IS BUILT TO NOT CARE. When it is
// missing this answers {"key":null} with a 200, the homepage's loadPlaces() resolves
// to null, and the "I'm at a hotel" box stays the plain text box it has always been —
// no address list, no error, nothing a guest can see. Setting the variable in the
// Netlify UI turns the suggestions on; unsetting it turns them off again. No deploy
// either way, beyond the cache below ageing out.
//
// Restrict the key in the Google Cloud console to the Maps JavaScript API and the
// Places API, and to this site's HTTP referrers. This endpoint deliberately does no
// checking of its own: a referrer test here would be security theatre — anyone can
// send any Referer header — and the real lock is the one on the key.
//
// Read-only. GET only. Nothing is logged, because the one thing it handles is the
// thing that must not end up in a log.

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: { Allow: 'GET' }, body: '' };
  }

  const key = (process.env.GOOGLE_MAPS_BROWSER_KEY || '').trim() || null;

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      // An hour at the edge, ten minutes in the browser. Long enough that a guest
      // opening the box costs nothing, short enough that switching the variable on
      // shows up the same morning rather than the next deploy.
      'Cache-Control': 'public, max-age=600, s-maxage=3600',
    },
    body: JSON.stringify({ key }),
  };
};
