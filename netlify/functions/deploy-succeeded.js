// IndexNow ping. Netlify runs a function named deploy-succeeded automatically after every
// successful deploy. It reads this site's sitemap and tells Bing (and the other IndexNow
// engines: Yandex, Seznam, Naver…) that those pages changed, so they recrawl in minutes
// instead of weeks. The key is public by design — the engines verify it by fetching
// https://cozumeltransfers.org/cb3afe300a19797fff1fc8d637f8194a.txt, which sits at the site root.
// Never throws: a failed ping must not look like a failed deploy.

const HOST = 'cozumeltransfers.org';
const KEY = 'cb3afe300a19797fff1fc8d637f8194a';

exports.handler = async (event) => {
  try {
    const deploy = (JSON.parse(event.body || '{}').payload) || {};
    // Only production deploys change what the public sees. Previews and branch deploys don't.
    if (deploy.context && deploy.context !== 'production') {
      console.log('indexnow: skipped, context', deploy.context);
      return { statusCode: 200, body: 'skipped' };
    }
    const xml = await (await fetch(`https://${HOST}/sitemap.xml`)).text();
    const urlList = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map(m => m[1]);
    if (!urlList.length) {
      console.log('indexnow: no URLs found in sitemap');
      return { statusCode: 200, body: 'no urls' };
    }
    const res = await fetch('https://api.indexnow.org/indexnow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ host: HOST, key: KEY, keyLocation: `https://${HOST}/${KEY}.txt`, urlList }),
    });
    console.log('indexnow:', res.status, urlList.length, 'urls');
    return { statusCode: 200, body: `indexnow ${res.status}` };
  } catch (err) {
    console.log('indexnow: failed', err && err.message);
    return { statusCode: 200, body: 'failed' };
  }
};
