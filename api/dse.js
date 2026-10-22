// Vercel serverless function: fetches public DSE pages for the web version of DSE Desk.
// Browsers can't read DSE directly (no CORS), so the page asks this function instead.
// Only three fixed DSE pages are allowed — this is not an open proxy.
// DSE retired www.dsebd.org in Oct 2026; the old pages still run on old.dsebd.org.

const BASE = 'https://old.dsebd.org';
const BB = 'https://provider.bullbd.com';
const UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36 DSE-Desk/1.3';

function target(q) {
  const page = String(q.page || '');
  if (page === 'latest') return { url: `${BASE}/latest_share_price_scroll_l.php`, ttl: 30 };
  // DSEX day-end closes (dse.com.bd's index page showed a fixed placeholder value)
  if (page === 'index') return { url: `${BB}/shares/get-eod-data-count?code=DSEX&upto=${new Date(Date.now() + 2 * 864e5).toISOString().slice(0, 10)}&count=3&col=d:1,c:1,_id:0`, ttl: 120 };
  if (page === 'archive') {
    const d = /^\d{4}-\d{2}-\d{2}$/;
    // "All Instrument" returns every stock and only works in that exact case
    const inst = String(q.inst || '') === 'All Instrument' ? 'All Instrument' : String(q.inst || '').toUpperCase();
    if (!d.test(q.startDate || '') || !d.test(q.endDate || '') || !/^([A-Z0-9&.\-]{1,20}|All Instrument)$/.test(inst)) return null;
    // a week of every stock is ~2.4 MB; keep whole-market requests to at most 7 days
    if (inst === 'All Instrument' && (Date.parse(q.endDate) - Date.parse(q.startDate)) / 864e5 > 6) return null;
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
