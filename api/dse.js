// Vercel serverless function: fetches public DSE pages for the web version of DSE Desk.
// Browsers can't read dsebd.org directly (no CORS), so the page asks this function instead.
// Only three fixed DSE pages are allowed — this is not an open proxy.

const BASE = 'https://www.dsebd.org';
const UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36 DSE-Desk/1.1';

function target(q) {
  const page = String(q.page || '');
  if (page === 'latest') return { url: `${BASE}/latest_share_price_scroll_l.php`, ttl: 30 };
  if (page === 'home') return { url: `${BASE}/`, ttl: 60 };
  if (page === 'archive') {
    const d = /^\d{4}-\d{2}-\d{2}$/;
    const inst = String(q.inst || '').toUpperCase();
    if (!d.test(q.startDate || '') || !d.test(q.endDate || '') || !/^[A-Z0-9&.\-]{1,20}$/.test(inst)) return null;
    return {
      url: `${BASE}/day_end_archive.php?startDate=${q.startDate}&endDate=${q.endDate}&inst=${encodeURIComponent(inst)}&archive=data`,
      ttl: 900,
    };
  }
  return null;
}

module.exports = async (req, res) => {
  const t = target(req.query || {});
  if (!t) {
    res.status(400).json({ error: 'bad request' });
    return;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(t.url, { headers: { 'User-Agent': UA, Accept: 'text/html' }, signal: ctrl.signal });
    const body = await r.text();
    if (!r.ok) {
      res.status(502).json({ error: `DSE answered ${r.status}` });
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', `public, s-maxage=${t.ttl}, stale-while-revalidate=${t.ttl * 4}`);
    res.status(200).send(body);
  } catch (e) {
    res.status(502).json({ error: e.name === 'AbortError' ? 'DSE timed out' : 'Could not reach DSE' });
  } finally {
    clearTimeout(timer);
  }
};
