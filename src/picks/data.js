// Data for the Shariah picks, kept on the phone (IndexedDB) and refreshed a little at a time.
//
// What is downloaded, and how often (sizes are approximate):
//   DSES members (TradingView, 5 KB) ............................ weekly
//   Prices for each DSES stock (BullBD, 16 KB each first time) .. once, then only the newest days (~1 KB each)
//   DSEX / DSES index history (BullBD) ......................... once, then the newest days
//   Quarterly EPS + dividends (BullBD, ~10 KB per stock) ........ weekly
//   Company page (DSE, ~325 KB each: category, sponsor %, AGM) .. 5 a day, so each is re-read about monthly;
//                                                                 starts from the facts bundled with the app
//   Policy rate + sector P/E (LankaBD, ~2.8 MB) ................. weekly
//   News (DSE, ~380 KB per stock) .............................. only when you open a stock's details
// The scan itself (scoring every stock) runs on the phone and takes about a second.
import { adjust, scan, recordHistory, scoreFrozen, addDays } from './engine.js';
import SEED from './seed.json';
import HIST_SEED from './history-seed.json';
import BACKTEST from './backtest.json';

export const BT = BACKTEST;
const BB = 'https://provider.bullbd.com';
const DSE = 'https://old.dsebd.org';
const DAY = 864e5;

/* ---------- small key-value store (IndexedDB, memory fallback) ---------- */
const mem = new Map();
let dbp = null;
function db() {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return (dbp ||= new Promise((res) => {
    const r = indexedDB.open('dsedesk-picks', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => res(null);
  }));
}
export async function kvGet(k) {
  const d = await db(); if (!d) return mem.get(k);
  return new Promise((res) => { const g = d.transaction('kv').objectStore('kv').get(k); g.onsuccess = () => res(g.result); g.onerror = () => res(undefined); });
}
export async function kvSet(k, v) {
  const d = await db(); if (!d) { mem.set(k, v); return; }
  return new Promise((res, rej) => { const t = d.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = () => res(); t.onerror = () => rej(t.error); });
}
export async function kvClear() {
  mem.clear(); const d = await db(); if (!d) return;
  return new Promise((res) => { const t = d.transaction('kv', 'readwrite'); t.objectStore('kv').clear(); t.oncomplete = () => res(); t.onerror = () => res(); });
}

/* ---------- fetching ---------- */
async function get(url, { timeout = 30000, json = false, init } = {}) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, { cache: 'no-store', signal: ctrl.signal, ...init });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return json ? await r.json() : await r.text();
  } finally { clearTimeout(t); }
}
const doc = (html) => new DOMParser().parseFromString(html, 'text/html');
const num = (s) => { const v = Number(String(s ?? '').replace(/,/g, '').replace(/%/, '')); return Number.isFinite(v) ? v : null; };
async function pool(items, n, fn, tick) {
  let i = 0; const out = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; try { out[k] = await fn(items[k], k); } catch { out[k] = null; } tick?.(); }
  }));
  return out;
}
const dhakaNow = () => new Date(Date.now() + (new Date().getTimezoneOffset() + 360) * 60000);
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
/** Last trading day whose closing prices are final (after 15:00 Dhaka), skipping Fri/Sat. Holidays aren't known. */
export function lastClosedDay() {
  const d = dhakaNow();
  if (!(d.getDay() <= 4 && d.getHours() >= 15)) { do d.setDate(d.getDate() - 1); while (d.getDay() > 4); }
  return ymd(d);
}

async function dsesList() {
  const body = { columns: ['name'], range: [0, 500], symbols: { symbolset: ['SYML:DSEBD;DSES'] }, markets: ['bangladesh'] };
  const j = await get('https://scanner.tradingview.com/bangladesh/scan', { json: true, init: { method: 'POST', headers: { 'content-type': 'text/plain;charset=UTF-8' }, body: JSON.stringify(body) } });
  const codes = (j.data || []).map((d) => d.s.replace('DSEBD:', '')).filter(Boolean);
  if (codes.length < 50) throw new Error('DSES list looks incomplete');
  return codes;
}
/** Daily rows [date, close, value mn, volume], oldest first. Drops today's row until the close is final. */
async function prices(code, count) {
  const upto = addDays(ymd(dhakaNow()), 1);
  const j = await get(`${BB}/shares/get-eod-data-count?code=${encodeURIComponent(code)}&upto=${upto}&count=${count}&col=d:1,c:1,v:1,vl:1,_id:0`, { json: true });
  const final = lastClosedDay();
  return (Array.isArray(j) ? j : []).filter((x) => x && x.c > 0 && x.d).map((x) => [x.d.slice(0, 10), x.c, x.vl ?? 0, x.v ?? 0]).filter((r) => r[0] <= final).sort((a, b) => (a[0] < b[0] ? -1 : 1));
}
async function indexHist(code, count) {
  const upto = addDays(ymd(dhakaNow()), 1);
  const j = await get(`${BB}/shares/get-eod-data-count?code=${code}&upto=${upto}&count=${count}&col=d:1,c:1,_id:0`, { json: true });
  return (Array.isArray(j) ? j : []).filter((x) => x && x.c > 0).map((x) => [x.d.slice(0, 10), x.c]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
}
async function bull(code) {
  const [q, ca] = await Promise.all([get(`${BB}/fundamentals/get-quaterly-history?share=${encodeURIComponent(code)}`, { json: true }), get(`${BB}/corporate-actions/get-corporate-actions?share=${encodeURIComponent(code)}`, { json: true })]);
  const quarters = (Array.isArray(q) ? q.flat() : []).filter((x) => x && x.quarter_ending_on && Number.isFinite(x.quaterly_eps_basic))
    .map((x) => ({ d: x.quarter_ending_on.slice(0, 10), q: x.quarter_name, eps: x.quaterly_eps_basic, nocf: x.quaterly_nocfps }))
    .sort((a, b) => (a.d < b.d ? 1 : -1)).filter((x, i, a) => a.findIndex((y) => y.d.slice(0, 7) === x.d.slice(0, 7)) === i);
  const acts = (Array.isArray(ca) ? ca : []).map((x) => ({ pub: (x.publish_date || '').slice(0, 10), cash: Number(x.cash) || 0, stock: Number(x.stock) || 0, rd: x.record_date ? x.record_date.slice(0, 10) : null })).filter((x) => x.pub).sort((a, b) => (a.pub < b.pub ? 1 : -1));
  return { quarters, acts, at: Date.now() };
}
async function company(code) {
  const d = doc(await get(`${DSE}/displayCompany.php?name=${encodeURIComponent(code)}`, { timeout: 45000 }));
  const cells = [...d.querySelectorAll('td,th')].map((x) => x.textContent.replace(/\s+/g, ' ').trim());
  const at = (l) => { const i = cells.findIndex((c) => c === l); return i >= 0 ? cells[i + 1] : null; };
  const txt = d.body.textContent.replace(/\s+/g, ' ');
  const hold = [...txt.matchAll(/Sponsor\/Director:\s*([\d.]+)\s*Govt:\s*([\d.]+)\s*Institute:\s*([\d.]+)\s*Foreign:\s*([\d.]+)\s*Public:\s*([\d.]+)/g)].map((m) => m.slice(1).map(Number));
  const h = hold.at(-1), hp = hold.length > 1 ? hold[0] : null;
  const out = { name: (txt.match(/Company Name:\s*(.+?)\s*Trading Code/) || [])[1] || code, sector: at('Sector'), cat: at('Market Category'), instr: at('Type of Instrument'),
    ffmcap: num(at('Free Float Market Cap. (mn)')), sponsor: h ? h[0] + h[1] : null, instChg: h && hp ? Math.round((h[2] - hp[2]) * 100) / 100 : null, lastAgm: (txt.match(/Last AGM held on:\s*([\d-]+)/) || [])[1] || null, at: Date.now() };
  if (!out.instr || !out.cat) throw new Error('company page not readable');
  return out;
}
async function policyRate() {
  const d = doc(await get('https://lankabd.com/Details/MoneyMarketDetail'));
  const row = (re) => { const tr = [...d.querySelectorAll('tr')].find((r) => re.test(r.textContent)); return tr ? num([...tr.cells][1]?.textContent) : null; };
  const r = { repo: row(/^\s*Repo Rate %/), sdf: row(/Standing Deposit Facility\(SDF\) Rate %/), call: row(/Average Interest rate\(%\)/) };
  if (!(r.repo > 0)) throw new Error('policy rate not found');
  return r;
}
async function lankaSectorPE() {
  const d = doc(await get('https://lankabd.com/Home/DataMatrix', { timeout: 60000 })); const t = [...d.querySelectorAll('table')].sort((a, b) => b.rows.length - a.rows.length)[0];
  const head = [...t.rows[0].cells].map((c) => c.textContent.trim()); const iS = head.indexOf('Sector'), iF = head.indexOf('Forward PE');
  const by = {}; for (const r of [...t.rows].slice(1)) { const c = [...r.cells].map((x) => x.textContent.trim()); const f = num(c[iF]); if (f > 0 && f < 80) (by[c[iS]] ||= []).push(f); }
  const med = (a) => a.sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const out = {}; for (const k in by) if (by[k].length >= 3) out[k] = Math.round(med(by[k]) * 100) / 100;
  if (Object.keys(out).length < 5) throw new Error('sector P/E not found');
  return out;
}
/** Latest 3 DSE notices for a stock over 60 days: [[date, title]]. Cached for a day. */
export async function news(code) {
  const cache = (await kvGet('news')) || {};
  if (cache[code] && Date.now() - cache[code].at < DAY) return cache[code].items;
  const to = ymd(dhakaNow()), from = addDays(to, -60);
  const d = doc(await get(`${DSE}/old_news.php?inst=${encodeURIComponent(code)}&startDate=${from}&endDate=${to}&criteria=3&archive=news`, { timeout: 45000 }));
  const rows = [...d.querySelectorAll('table tr')].map((r) => r.textContent.replace(/\s+/g, ' ').trim()); const out = [];
  for (let i = 0; i < rows.length; i++) if (rows[i].startsWith('News Title:')) {
    const t = rows[i].slice(11).replace(new RegExp('^' + code.replace(/[()&.]/g, '\\$&') + ':\\s*'), '');
    const pd = rows.slice(i, i + 4).find((x) => x.startsWith('Post Date:'));
    out.push([pd ? pd.slice(11) : null, t.trim().replace(/^[^:]{2,20}:\s*/, '').slice(0, 140)]);
  }
  const seen = new Set();
  const items = out.filter((x) => !/^Price Limit Open$/i.test(x[1]) && !seen.has(x[1]) && seen.add(x[1])).slice(0, 3);
  cache[code] = { at: Date.now(), items };
  for (const k of Object.keys(cache)) if (Date.now() - cache[k].at > 7 * DAY) delete cache[k];
  await kvSet('news', cache);
  return items;
}

/* ---------- the update ---------- */
const mergeRows = (old = [], fresh = [], keep = 600) => {
  const m = new Map(old.map((r) => [r[0], r])); for (const r of fresh) m.set(r[0], r);
  return [...m.values()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(-keep);
};
export const progress = { running: false, step: '', done: 0, total: 0, error: '' };
let running = null;

/** Latest saved scan, or null. */
export const loadScan = () => kvGet('scan');
export const loadHistory = async () => (await kvGet('hist')) || JSON.parse(JSON.stringify(HIST_SEED));
export const loadState = async () => (await kvGet('state')) || {};

/** Whether a new scan is due: the saved one is older than the last closed trading day (checked at most every 4 hours). */
export async function isDue() {
  const [s, st] = await Promise.all([loadScan(), loadState()]);
  if (!s) return false; // first setup is started by the user (it downloads ~7 MB)
  if (st.lastRunAt && Date.now() - st.lastRunAt < 4 * 3600e3) return false;
  return s.asOf < lastClosedDay();
}

/**
 * Brings the saved data up to date and runs the scan. onTick() is called as work progresses.
 * Returns the new scan. Only one update runs at a time.
 */
export function updatePicks(onTick = () => {}) {
  return (running ||= run(onTick).finally(() => { running = null; progress.running = false; onTick(); }));
}
async function run(onTick) {
  Object.assign(progress, { running: true, step: 'Starting…', done: 0, total: 0, error: '' }); onTick();
  const phase = (step, total) => { Object.assign(progress, { step, done: 0, total }); onTick(); };
  const tick = () => { progress.done++; onTick(); };
  const st = await loadState();
  const now = Date.now();
  try {
    // 1. Who is in the Shariah index
    let codes = st.dses;
    if (!codes || !st.dsesAt || now - st.dsesAt > 7 * DAY) {
      phase('Shariah index members', 1);
      try { const fresh = await dsesList(); if (codes && fresh.join() !== codes.join()) st.prevDses = codes; codes = fresh; st.dsesAt = now; } catch { codes ||= SEED.dses; }
      tick();
    }
    // 2. Prices: a year the first time, then only the newest days
    const px = (await kvGet('px')) || {};
    const final = lastClosedDay();
    const needPx = codes.filter((c) => !px[c] || px[c].length < 130 || px[c].at(-1)[0] < final);
    phase('Prices', needPx.length);
    await pool(needPx, 6, async (c) => { const first = !px[c] || px[c].length < 130; const rows = await prices(c, first ? 300 : 15); if (rows.length) px[c] = mergeRows(first ? [] : px[c], rows); }, tick);
    await kvSet('px', px);
    // 3. Index history
    phase('DSEX and DSES index', 2);
    const idx = (await kvGet('idx')) || {};
    for (const k of ['DSEX', 'DSES']) { try { const rows = await indexHist(k, idx[k]?.length > 300 ? 30 : 5000); if (rows.length) idx[k] = mergeRows(idx[k], rows, 6000); } catch {} tick(); }
    await kvSet('idx', idx);
    // 4. Quarterly results and dividends, weekly per stock
    const bl = (await kvGet('bull')) || {};
    const needB = codes.filter((c) => !bl[c] || now - bl[c].at > 7 * DAY);
    phase('Quarterly results and dividends', needB.length);
    await pool(needB, 5, async (c) => { bl[c] = await bull(c); }, tick);
    await kvSet('bull', bl);
    // 5. Company facts: bundled starter facts, then 5 company pages a day (oldest first)
    const co = (await kvGet('co')) || JSON.parse(JSON.stringify(SEED.co));
    const stale = codes.filter((c) => !co[c]?.at || now - co[c].at > 30 * DAY)
      .sort((a, b) => (co[a] ? 1 : 0) - (co[b] ? 1 : 0) || (co[a]?.at || 0) - (co[b]?.at || 0));
    const missing = stale.filter((c) => !co[c]);
    const take = [...new Set([...missing.slice(0, 15), ...stale.slice(0, 5)])];
    phase('Company pages', take.length);
    await pool(take, 3, async (c) => { co[c] = { ...(co[c] || {}), ...(await company(c)) }; }, tick);
    await kvSet('co', co);
    // 6. Policy rate and sector P/E, weekly
    if (!st.ratesAt || now - st.ratesAt > 7 * DAY) {
      phase('Policy rate and sector P/E', 2);
      try { st.rates = await policyRate(); st.ratesAt = now; } catch {} tick();
      try { st.sectorPE = await lankaSectorPE(); } catch {} tick();
    }
    // 7. Score
    phase('Scoring', 1);
    const U = codes.map((code) => ({ code, c: co[code] || {}, b: bl[code] || { quarters: [], acts: [] }, rows: px[code] }))
      .filter((u) => u.rows?.length && (u.c.instr || 'Equity') === 'Equity')
      .map((u) => ({ code: u.code, c: u.c, b: u.b, s: adjust(u.rows, u.b.acts) }));
    if (U.length < 30) throw new Error(`only ${U.length} stocks have prices`);
    if (!(idx.DSEX?.length > 200 && idx.DSES?.length > 200)) throw new Error('index history missing');
    const S = scan({ U, codes, prevDses: st.prevDses || [], dsex: idx.DSEX, dses: idx.DSES, rates: st.rates || null, sectorPE: st.sectorPE || {} });
    const hist = scoreFrozen(recordHistory(await loadHistory(), S), U, idx.DSES);
    await kvSet('scan', S); await kvSet('hist', hist);
    st.dses = codes; st.lastRunAt = Date.now(); st.lastOkAt = Date.now();
    await kvSet('state', st);
    tick();
    return S;
  } catch (e) {
    progress.error = e?.message || 'update failed';
    st.lastRunAt = Date.now(); await kvSet('state', st).catch(() => {});
    throw e;
  }
}
