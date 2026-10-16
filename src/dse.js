// DSE data layer: fetches and parses public DSE pages.
// DSE moved to dse.com.bd in Oct 2026 and retired the old pages on www.dsebd.org. The same pages still
// run on old.dsebd.org, so prices and history come from there; the DSEX index comes from dse.com.bd.
// Android app: CapacitorHttp requests DSE directly (no CORS limits).
// Website: requests go through the site's own /api/dse function, which fetches DSE server-side.
import { Capacitor } from '@capacitor/core';

const BASE = 'https://old.dsebd.org';
const NEW = 'https://www.dse.com.bd';
export const ALL = 'All Instrument'; // archive "instrument" that returns every stock (DSE needs this exact case)
export const VIA_PROXY = !Capacitor.isNativePlatform();
const P = '/api/dse?page=';

export const URLS = VIA_PROXY
  ? {
      latest: `${P}latest`,
      index: `${P}index`,
      archive: (code, from, to) => `${P}archive&startDate=${from}&endDate=${to}&inst=${encodeURIComponent(code)}`,
    }
  : {
      latest: `${BASE}/latest_share_price_scroll_l.php`,
      index: `${NEW}/indices/DSEX`,
      archive: (code, from, to) =>
        `${BASE}/day_end_archive.php?startDate=${from}&endDate=${to}&inst=${encodeURIComponent(code)}&archive=data`,
    };

export function num(s) {
  if (s == null) return NaN;
  const t = String(s).replace(/[,\s৳]/g, '').replace(/[−–]/g, '-');
  if (t === '' || t === '-' || t === '--') return NaN;
  return parseFloat(t);
}

const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z]/g, '');

async function getText(url, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
    if (!r.ok) {
      let msg = `HTTP ${r.status}`;
      try { const j = await r.json(); if (j.error) msg = j.error; } catch {}
      throw new Error(msg);
    }
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

function findTable(doc, mustHave) {
  const tables = [...doc.querySelectorAll('table')];
  for (const tb of tables) {
    const head = norm(tb.querySelector('tr')?.textContent);
    if (mustHave.every((h) => head.includes(h))) return tb;
  }
  return null;
}

function headerIndex(table) {
  const first = table.querySelector('tr');
  const cells = [...first.querySelectorAll('th,td')].map((c) => norm(c.textContent));
  const idx = {};
  cells.forEach((c, i) => {
    if (c.startsWith('TRADINGCODE')) idx.code = i;
    else if (c === 'DATE') idx.date = i;
    else if (c.startsWith('LTP')) idx.ltp = i;
    else if (c === 'HIGH') idx.high = i;
    else if (c === 'LOW') idx.low = i;
    else if (c.startsWith('OPENP')) idx.open = i;
    else if (c.startsWith('CLOSEP')) idx.close = i;
    else if (c.startsWith('YCP')) idx.ycp = i;
    else if (c.startsWith('CHANGE')) idx.change = i;
    else if (c.startsWith('TRADE')) idx.trade = i;
    else if (c.startsWith('VALUE')) idx.value = i;
    else if (c.startsWith('VOLUME')) idx.volume = i;
  });
  return idx;
}

/** Parse the "latest share price" page into { CODE: quote } */
export function parseLatest(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const table = findTable(doc, ['TRADINGCODE', 'LTP']);
  const out = {};
  let idx;
  let rows;
  if (table) {
    idx = headerIndex(table);
    rows = [...table.querySelectorAll('tr')].slice(1);
  } else {
    // Fallback: any rows with 11 cells in the standard DSE order
    idx = { code: 1, ltp: 2, high: 3, low: 4, close: 5, ycp: 6, change: 7, trade: 8, value: 9, volume: 10 };
    rows = [...doc.querySelectorAll('tr')];
  }
  for (const tr of rows) {
    const td = [...tr.querySelectorAll('td')].map((c) => c.textContent.trim());
    if (td.length < 8) continue;
    const code = (td[idx.code] || '').replace(/\s+/g, '').toUpperCase();
    if (!code || !/^[A-Z0-9&.\-]+$/.test(code)) continue;
    const ycp = num(td[idx.ycp]);
    let ltp = num(td[idx.ltp]);
    if (!(ltp > 0)) ltp = ycp; // not traded today -> last close
    if (!(ltp > 0)) continue;
    let change = idx.change != null ? num(td[idx.change]) : NaN;
    if (isNaN(change) && !isNaN(ycp)) change = ltp - ycp;
    out[code] = {
      code,
      ltp,
      high: num(td[idx.high]),
      low: num(td[idx.low]),
      close: num(td[idx.close]),
      ycp,
      change,
      changePct: ycp > 0 ? (change / ycp) * 100 : 0,
      trade: num(td[idx.trade]),
      value: num(td[idx.value]), // in BDT million
      volume: num(td[idx.volume]),
    };
  }
  return out;
}

export async function fetchLatest() {
  const html = await getText(URLS.latest);
  const q = parseLatest(html);
  if (Object.keys(q).length < 10) throw new Error('Could not read the DSE price table');
  return q;
}

/** Best-effort DSEX index from the dse.com.bd index page ("Level 6,241.30 Prev close 6,222.90") */
export function parseIndex(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script,style').forEach((n) => n.remove());
  const text = (doc.body?.textContent || '').replace(/\s+/g, ' ');
  const m = text.match(/Level\s*([\d,]+\.\d+)\s*Prev close\s*([\d,]+\.\d+)/i);
  if (!m) return null;
  const value = num(m[1]), prev = num(m[2]);
  if (!(value > 0)) return null;
  const change = prev > 0 ? value - prev : NaN;
  return { value, change, changePct: prev > 0 ? (change / prev) * 100 : NaN };
}

let ixCache = null; // the index page is ~500 KB, so fetch it at most every 5 minutes
export async function fetchIndex() {
  if (ixCache && Date.now() - ixCache.at < 5 * 60000) return ixCache.ix;
  try {
    const ix = parseIndex(await getText(URLS.index, 20000));
    if (ix) ixCache = { at: Date.now(), ix };
    return ix;
  } catch {
    return null;
  }
}

/** Parse day-end archive: returns [{code, date, open, high, low, close, ycp, value, volume}] oldest first */
export function parseArchive(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const table = findTable(doc, ['DATE', 'TRADINGCODE']);
  if (!table) return [];
  const idx = headerIndex(table);
  const out = [];
  for (const tr of [...table.querySelectorAll('tr')].slice(1)) {
    const td = [...tr.querySelectorAll('td')].map((c) => c.textContent.trim());
    if (td.length < 6) continue;
    const date = td[idx.date];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    let close = num(td[idx.close]);
    if (!(close > 0)) close = num(td[idx.ltp]);
    if (!(close > 0)) continue;
    out.push({
      code: (td[idx.code] || '').replace(/\s+/g, '').toUpperCase(),
      date,
      open: num(td[idx.open]),
      high: num(td[idx.high]),
      low: num(td[idx.low]),
      close,
      ycp: num(td[idx.ycp]),
      value: num(td[idx.value]), // BDT million
      volume: num(td[idx.volume]),
    });
  }
  out.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

export async function fetchHistory(code, days) {
  const to = new Date();
  const from = new Date(Date.now() - days * 864e5);
  const f = (d) => d.toISOString().slice(0, 10);
  return parseArchive(await getText(URLS.archive(code, f(from), f(to)), 30000));
}

/**
 * Day-end rows for every stock over the last `calDays` calendar days: { CODE: [rows oldest first] }.
 * Fetched a week at a time (~2.4 MB each) so each response stays small enough for the website's server function.
 */
export async function fetchMarketHistory(calDays, onProgress) {
  const f = (d) => d.toISOString().slice(0, 10);
  const end = Date.now();
  const weeks = [];
  for (let back = 0; back < calDays; back += 7) {
    weeks.push([f(new Date(end - Math.min(back + 6, calDays - 1) * 864e5)), f(new Date(end - back * 864e5))]);
  }
  const by = {};
  let done = 0;
  await Promise.all(weeks.map(async ([from, to]) => {
    const rows = parseArchive(await getText(URLS.archive(ALL, from, to), 60000));
    for (const r of rows) (by[r.code] ||= []).push(r);
    onProgress?.(++done, weeks.length);
  }));
  for (const k in by) by[k].sort((a, b) => a.date.localeCompare(b.date));
  if (Object.keys(by).length < 10) throw new Error('Could not read the DSE archive');
  return by;
}

/** DSE trades Sun–Thu, 10:00–14:30 Dhaka time (UTC+6). Holidays are not tracked. */
export function marketStatus(now = new Date()) {
  const dhaka = new Date(now.getTime() + (now.getTimezoneOffset() + 360) * 60000);
  const day = dhaka.getDay(); // 0 Sun ... 6 Sat
  const mins = dhaka.getHours() * 60 + dhaka.getMinutes();
  const tradingDay = day >= 0 && day <= 4;
  const open = tradingDay && mins >= 600 && mins < 870;
  return { open, tradingDay, label: open ? 'Market open' : 'Market closed', dhaka };
}
