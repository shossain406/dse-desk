// Shariah picks engine: ranks DSE Shariah index (DSES) stocks for 3, 6 and 12 months.
// Ported from DSE Signal Desk's scripts/runner.js (live scan + frozen-pick scoring). The formulas, weights and
// filters are unchanged; only the data loading differs (see data.js, which keeps price history on the phone).
//
// Input universe U: [{ code, c: company facts, b: { quarters, acts }, s: adjust(rows, acts) }]
// Price rows are [date, close, value (BDT mn), volume], oldest first.

export const r2 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);
const cl = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const iso = (d) => d.toISOString().slice(0, 10);
export const addDays = (s, n) => iso(new Date(new Date(s + 'T00:00:00Z').getTime() + n * 864e5));
const median = (a) => { a = a.filter(Number.isFinite).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : null; };
const sd = (a) => { if (a.length < 2) return 0; const m = a.reduce((s, x) => s + x, 0) / a.length; return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const H = { 3: { d: 66, k: 0.25, c: 0.5 }, 6: { d: 132, k: 0.45, c: 0.6 }, 12: { d: 250, k: 0.7, c: 0.75 } };
const BETA = { 3: 0.0464, 6: 0.1848, 12: 0.3844 }; // fitted slope of horizon excess return on 6m momentum
export const idxAt = (dates, asof) => { let lo = 0, hi = dates.length - 1, ans = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (dates[m] <= asof) { ans = m; lo = m + 1; } else hi = m - 1; } return ans; };

/* ---------- dividend / bonus back-adjustment ---------- */
// On the first trading day after each record date, earlier prices are scaled by (P - cash)/P / (1 + stock%),
// cash in taka = cash% of the ৳10 face value.
export function adjust(rows, acts = []) {
  const dates = rows.map((x) => x[0]), raw = rows.map((x) => x[1]), f = new Array(rows.length).fill(1);
  for (const a of acts) {
    if (!a.rd || !(a.cash > 0 || a.stock > 0)) continue; const k = idxAt(dates, a.rd); if (k < 0 || k >= rows.length - 1) continue;
    const P = raw[k]; if (!(P > 0)) continue; const fac = Math.max(0.05, (P - a.cash / 10) / P) / (1 + (a.stock || 0) / 100);
    for (let i = 0; i <= k; i++) f[i] *= fac;
  }
  return { dates, adj: raw.map((x, i) => x * f[i]), raw, value: rows.map((x) => x[2]), vol: rows.map((x) => x[3]) };
}

/* ---------- analytics ---------- */
function priceStats(s, i) {
  if (i < 120) return null; const c = s.adj.slice(0, i + 1), n = c.length, last = c[n - 1];
  const sma = (k, j = n - 1) => (j + 1 >= k ? c.slice(j + 1 - k, j + 1).reduce((a, x) => a + x, 0) / k : null);
  const lr = c.slice(1).map((x, k) => Math.log(x / c[k])).filter((x) => Number.isFinite(x) && Math.abs(x) < 0.25);
  const sig = Math.max(sd(lr.slice(-60)), sd(lr.slice(-250)));
  let g = 0, l = 0; const R = c.slice(-15); for (let k = 1; k < R.length; k++) { const d = R[k] - R[k - 1]; d > 0 ? (g += d) : (l -= d); }
  const s50 = sma(50), s200 = sma(200), s50p = sma(50, n - 21); const v = s.value.slice(Math.max(0, i - 19), i + 1), vol = s.vol.slice(Math.max(0, i - 59), i + 1);
  let pk = c[Math.max(0, n - 250)], mdd = 0; for (const x of c.slice(-250)) { pk = Math.max(pk, x); mdd = Math.min(mdd, x / pk - 1); }
  return { price: s.raw[i], sig, t20: v.reduce((a, x) => a + (x || 0), 0) / v.length, zeroDays: vol.filter((x) => !(x > 0)).length, above200: s200 ? last > s200 : false, slope50: s50p ? (s50 / s50p - 1) * 100 : 0,
    rsi: l === 0 ? 100 : 100 - 100 / (1 + g / l), ret3m: n > 66 ? (last / c[n - 67] - 1) * 100 : null, ret6m: n > 132 ? (last / c[n - 133] - 1) * 100 : null, mdd: mdd * 100, vol: sig * Math.sqrt(240) * 100 };
}
// Price-volume read and moving-average / MACD crossovers (shown for context; not part of the score - untested).
function pvStats(s, i) {
  if (!s || i < 60) return null;
  const c = s.adj.slice(0, i + 1), v = s.vol.slice(0, i + 1).map((x) => (x > 0 ? x : 0)), n = c.length;
  const avg = (a) => (a.length ? a.reduce((p, x) => p + x, 0) / a.length : 0);
  const v20 = avg(v.slice(-21, -1)), v50 = avg(v.slice(-50));
  let up = 0, dn = 0; for (let k = n - 20; k < n; k++) { if (c[k] > c[k - 1]) up += v[k]; else if (c[k] < c[k - 1]) dn += v[k]; }
  let obv = 0; const ob = [0]; for (let k = n - 40; k < n; k++) { obv += c[k] > c[k - 1] ? v[k] : c[k] < c[k - 1] ? -v[k] : 0; ob.push(obv); }
  const obv20 = v20 > 0 ? (ob.at(-1) - ob.at(-21)) / (20 * v20) : 0;
  const r1 = (c[n - 1] / c[n - 2] - 1) * 100, r5 = (c[n - 1] / c[n - 6] - 1) * 100, r20 = (c[n - 1] / c[n - 21] - 1) * 100;
  const rv = v20 > 0 ? v[n - 1] / v20 : null, v5 = v50 > 0 ? avg(v.slice(-5)) / v50 : null, udr = dn > 0 ? up / dn : up > 0 ? 9.99 : 1;
  let read;
  if (r20 > 2 && udr >= 1.2) read = 'Accumulation: price rising on heavier buying volume';
  else if (r20 > 2 && udr < 0.9) read = 'Weak rally: price rising but volume favours sellers';
  else if (r20 < -2 && udr <= 0.8) read = 'Distribution: price falling on heavier selling volume';
  else if (r20 < -2) read = 'Quiet pullback: price falling on light selling volume';
  else read = udr >= 1.2 ? 'Flat price, buyers more active' : udr <= 0.8 ? 'Flat price, sellers more active' : 'Flat price, balanced volume';
  if (rv >= 2) read += ` · volume spike today (${rv.toFixed(1)}× normal, price ${r1 >= 0 ? '+' : ''}${r1.toFixed(1)}%)`;
  const sma = (k) => { const o = new Array(n).fill(null); let sum = 0; for (let j = 0; j < n; j++) { sum += c[j]; if (j >= k) sum -= c[j - k]; if (j >= k - 1) o[j] = sum / k; } return o; };
  const ema = (a, k) => { const o = new Array(a.length).fill(null), al = 2 / (k + 1); let e = null; for (let j = 0; j < a.length; j++) { if (a[j] == null) continue; e = e == null ? a[j] : a[j] * al + e * (1 - al); o[j] = e; } return o; };
  const S20 = sma(20), S50 = sma(50), S200 = sma(200);
  const e12 = ema(c, 12), e26 = ema(c, 26), mac = c.map((_, j) => (j >= 25 ? e12[j] - e26[j] : null)), sg = ema(mac, 9);
  const cross = (a, b, look = 250) => { const j0 = n - 1; if (a[j0] == null || b[j0] == null) return null; const st = a[j0] > b[j0] ? 1 : -1; let d = null; for (let j = j0; j > Math.max(0, j0 - look); j--) { if (a[j - 1] == null || b[j - 1] == null) break; if ((a[j - 1] > b[j - 1] ? 1 : -1) !== st) { d = j0 - j; break; } } return [st, d]; };
  return { pv: { rv: r2(rv), v5: r2(v5), udr: r2(udr), obv: r2(obv20), r5: r2(r5), r20: r2(r20), read },
    xo: { s20: r2(S20[n - 1]), s50: r2(S50[n - 1]), s200: r2(S200[n - 1]), p50: cross(c, S50), m2050: cross(S20, S50), m50200: cross(S50, S200), macd: cross(mac, sg), hist: r2(mac[n - 1] - sg[n - 1]) } };
}
function quartersAsOf(qs, asof) {
  const av = qs;
  if (av.length < 4) return null;
  const ly = (u) => av.find((v) => { const dd = (new Date(u.d) - new Date(v.d)) / 864e5; return dd > 330 && dd < 400; });
  const ttm = av.slice(0, 4).reduce((a, x) => a + x.eps, 0), ttmP = av.length >= 8 ? av.slice(4, 8).reduce((a, x) => a + x.eps, 0) : null;
  const last = av[0], p = ly(last); const i1 = av.findIndex((u) => u.q === 'Q1'); const ytd = i1 >= 0 ? av.slice(0, i1 + 1).reduce((a, x) => a + x.eps, 0) : null;
  return { lastQ: last.q + ' ' + last.d.slice(0, 7), lastQd: last.d, qEps: r2(last.eps), qEpsLY: p ? r2(p.eps) : null, qYoY: p && p.eps > 0 ? r2((last.eps / p.eps - 1) * 100) : null,
    ttm: r2(ttm), ttmG: ttmP > 0 ? r2((ttm / ttmP - 1) * 100) : null, cash: ytd > 0 && Number.isFinite(last.nocf) ? r2(last.nocf / ytd) : null,
    yoyPos: av.slice(0, 4).filter((u) => { const v = ly(u); return v && u.eps > v.eps; }).length, ageDays: Math.round((new Date(asof) - new Date(last.d)) / 864e5) };
}
function divAsOf(acts, asof, untilDate) {
  const known = acts.filter((x) => x.pub <= asof); const last = known[0]; if (!last) return { dps: 0, note: null, lastCash: 0 };
  const up = known.find((x) => x.rd && x.rd >= asof && x.rd <= untilDate && x.cash > 0);
  if (up) return { dps: up.cash / 10, note: `Declared ${up.cash}% cash, record date ${up.rd}`, lastCash: last.cash, rd: up.rd };
  const lastPaid = known.find((x) => x.cash > 0 && x.rd); if (!lastPaid) return { dps: 0, note: null, lastCash: last.cash };
  let next = addDays(lastPaid.rd, 365); while (next < asof) next = addDays(next, 365);
  if (next <= untilDate) return { dps: lastPaid.cash / 10, note: `Expected ≈${lastPaid.cash}% (last year's), record ≈${next.slice(0, 7)}`, lastCash: lastPaid.cash };
  return { dps: 0, note: null, lastCash: lastPaid.cash };
}
// Expected-return model
function evaluate(U, asof, h, opt = {}) {
  const P = H[h], until = addDays(asof, Math.round(h * 30.4)), cap = opt.cap ?? 12;
  const rows = [];
  for (const u of U) {
    const i = idxAt(u.s.dates, asof); if (i < 0 || u.s.dates[i] < addDays(asof, -10)) continue;
    const ps = priceStats(u.s, i); if (!ps) continue; const q = quartersAsOf(u.b.quarters, asof);
    if (!q || !(q.ttm > 0) || !(ps.t20 >= 2) || ps.zeroDays >= 5 || !(q.ageDays < 270) || !['A', 'B'].includes(u.c.cat)) continue;
    rows.push({ u, i, ps, q });
  }
  const secPE = {}; for (const r of rows) { const pe = r.ps.price / r.q.ttm; if (pe > 0 && pe < 60) (secPE[r.u.c.sector] ||= []).push(pe); }
  for (const k in secPE) secPE[k] = secPE[k].length >= 3 ? median(secPE[k]) : null;
  const out = [];
  for (const { u, ps, q } of rows) {
    const sPE = (opt.sectorPE && opt.sectorPE[u.c.sector]) || secPE[u.c.sector] || cap;
    const g = cl(q.ttmG ?? 0, -30, 30), fwd = q.ttm * (1 + g / 200);
    const prem = q.ttmG != null && q.ttmG <= 100 && (q.yoyPos || 0) >= 3 ? cl(q.ttmG, 0, 40) / 100 : 0;
    let fairPE = Math.min(16, Math.min(cap, sPE) * (1 + prem)); if (/Fuel/.test(u.c.sector)) fairPE = Math.min(fairPE, 12);
    const fair = fairPE * fwd, z = ps.sig * Math.sqrt(P.d), p = ps.price;
    const base = Math.max(p * Math.exp(-P.c * z), Math.min(p + P.k * (fair - p), p * Math.exp(P.c * z)));
    const dv = divAsOf(u.b.acts, asof, until), tot = ((base + dv.dps) / p) * 100 - 100;
    out.push({ c: u.code, n: u.c.name, s: u.c.sector, cat: u.c.cat, p, t20: r2(ps.t20), a200: ps.above200, slope50: r2(ps.slope50), rsi: r2(ps.rsi), r3: r2(ps.ret3m), r6: r2(ps.ret6m), vol: r2(ps.vol), mdd: r2(ps.mdd),
      ...q, pe: r2(p / q.ttm), fairPE: r2(fairPE), fair: r2(fair), up: r2((fair / p - 1) * 100), dps: r2(dv.dps), dnote: dv.note, lastCash: dv.lastCash, base: r2(base), tot: r2(tot),
      lo: r2(p * Math.exp(-z)), hi: r2(p * Math.exp(z)), z: r2(z), sponsor: u.c.sponsor, instChg: u.c.instChg });
  }
  return out;
}
function riskScore(U, asof) { // cross-sectional 0-100 (higher = riskier)
  const rows = []; for (const u of U) { const i = idxAt(u.s.dates, asof); if (i < 0) continue; const ps = priceStats(u.s, i); if (!ps) continue; const q = quartersAsOf(u.b.quarters, asof); rows.push({ u, ps, q }); }
  const pr = (vals, v, dir = 1) => { const a = vals.filter(Number.isFinite).sort((x, y) => x - y); if (!Number.isFinite(v) || !a.length) return 0.5; let k = 0; while (k < a.length && a[k] < v) k++; const p = k / Math.max(1, a.length - 1); return dir > 0 ? p : 1 - p; };
  const vols = rows.map((r) => r.ps.vol), mdds = rows.map((r) => r.ps.mdd), t20s = rows.map((r) => r.ps.t20); const catR = { A: 0, B: 0.5, N: 0.4, Z: 1 };
  return rows.map(({ u, ps, q }) => {
    const ttm = q?.ttm ?? null; const pe = ttm > 0 ? ps.price / ttm : null; const lastCash = (u.b.acts.find((x) => x.cash > 0) || {}).cash || 0;
    const weak = (!(ttm > 0) ? 0.5 : 0) + ((q?.ttmG ?? 0) < 0 ? 0.25 : 0) + (lastCash > 0 ? 0 : 0.25); const valX = !(pe > 0) || pe > 40 ? 1 : pe > 25 ? 0.5 : 0;
    // free-float market cap is only known once the company page has been read; unknown counts as not small
    const gov = (u.c.sponsor != null && u.c.sponsor < 30 ? 0.6 : 0) + (u.c.ffmcap != null && u.c.ffmcap < 500 ? 0.4 : 0);
    const risk = Math.round(100 * (0.25 * pr(vols, ps.vol) + 0.15 * pr(mdds, ps.mdd, -1) + 0.15 * pr(t20s, ps.t20, -1) + 0.15 * (catR[u.c.cat] ?? 0.5) + 0.15 * weak + 0.05 * valX + 0.1 * gov));
    return { c: u.code, n: u.c.name, s: u.c.sector, cat: u.c.cat, p: ps.price, t20: r2(ps.t20), vol: r2(ps.vol), mdd: r2(ps.mdd), r3: r2(ps.ret3m), ttm, ttmG: q?.ttmG ?? null, pe: r2(pe), y: r2((lastCash / 10 / ps.price) * 100), sp: u.c.sponsor, risk, lastAgm: u.c.lastAgm };
  });
}
export function regime(idx, asof) {
  const i = idxAt(idx.map((x) => x[0]), asof); if (i < 200) return null; const c = idx.slice(0, i + 1).map((x) => x[1]); const n = c.length;
  const sma = (k, j = n - 1) => c.slice(j + 1 - k, j + 1).reduce((a, x) => a + x, 0) / k; const s200 = sma(200), s50 = sma(50), s50p = sma(50, n - 21);
  const trend = c[n - 1] > s200 && s50 > s50p ? 'up' : c[n - 1] < s200 && s50 < s50p ? 'down' : 'sideways';
  return { last: r2(c[n - 1]), sma200: r2(s200), sma50: r2(s50), pctVs200: r2((c[n - 1] / s200 - 1) * 100), slope50: r2((s50 / s50p - 1) * 100), ret3m: r2((c[n - 1] / c[n - 67] - 1) * 100), trend };
}

/* ---------- the daily scan (same output shape as Signal Desk's scan.json) ---------- */
export function scan({ U, codes, prevDses = [], dsex, dses, rates, sectorPE: lsec = {} }) {
  const asof = U.reduce((m, u) => (u.s.dates.at(-1) > m ? u.s.dates.at(-1) : m), '');
  const horizons = {}, positive = {};
  // Ranking: combined score 0-100 = 70% technical + 15% earnings growth + 15% quality, each a percentile among eligible DSES stocks.
  const pctl = (vals, v) => { const a = vals.filter(Number.isFinite).sort((x, y) => x - y); if (!Number.isFinite(v) || !a.length) return 0.5; let k = 0; while (k < a.length && a[k] < v) k++; return k / Math.max(1, a.length - 1); };
  const techScore = (x, ref) => (pctl(ref.map((y) => y.r6), x.r6) * 2 + pctl(ref.map((y) => y.r3), x.r3) + (x.a200 ? 1 : 0) + (x.slope50 > 0 ? 1 : 0) + (x.rsi > 75 ? 0 : 0.5)) / 5.5;
  let REF = [];
  for (const h of [3, 6, 12]) {
    const L = evaluate(U, asof, h, { sectorPE: lsec }); const med = median(L.map((x) => cl(x.r6 ?? 0, -60, 120)));
    REF = L; const yl = L.map((y) => (y.lastCash || 0) / 10 / y.p);
    for (const x of L) {
      const T = techScore(x, L), G = (pctl(L.map((y) => y.ttmG), x.ttmG) + pctl(L.map((y) => y.qYoY), x.qYoY) + (x.yoyPos || 0) / 4) / 3, Q = (pctl(L.map((y) => y.cash), x.cash) + pctl(yl, (x.lastCash || 0) / 10 / x.p)) / 2;
      x.T = Math.round(T * 100); x.G = Math.round(G * 100); x.Q = Math.round(Q * 100); x.sc = r2(100 * (0.7 * T + 0.15 * G + 0.15 * Q));
      x.exp = r2(BETA[h] * (cl(x.r6 ?? 0, -60, 120) - med)); x.trend = !!(x.a200 && x.slope50 > 0);
    }
    L.sort((a, b) => b.sc - a.sc); horizons[h] = L; positive[h] = L.filter((x) => x.sc >= 65).length; horizons['n' + h] = L.length; horizons['med' + h] = r2(med);
  }
  // Stocks that fail the quality filters are still ranked (ok:false with the reason).
  const elig = new Set(horizons[3].map((x) => x.c)), extra = [];
  for (const u of U) {
    if (elig.has(u.code)) continue; const i = u.s.dates.length - 1; if (u.s.dates[i] < addDays(asof, -10)) continue;
    const ps = priceStats(u.s, i); if (!ps || ps.ret6m == null) continue; const q = quartersAsOf(u.b.quarters, asof); const why = [];
    if (!['A', 'B'].includes(u.c.cat)) why.push((u.c.cat || '?') + ' category'); if (!(q && q.ttm > 0)) why.push(q ? 'loss-making (last 12m)' : 'results missing'); else if (!(q.ageDays < 270)) why.push('results overdue');
    if (!(ps.t20 >= 2)) why.push('thin trading'); if (ps.zeroDays >= 5) why.push('days without trades');
    extra.push({ u, ps, q, why: why.join(', ') });
  }
  for (const h of [3, 6, 12]) {
    const med = horizons['med' + h];
    const ex = extra.map(({ u, ps, q, why }) => { const z = ps.sig * Math.sqrt(H[h].d), p = ps.price; return { c: u.code, n: u.c.name, s: u.c.sector, cat: u.c.cat, p, t20: r2(ps.t20), a200: ps.above200, slope50: r2(ps.slope50), rsi: r2(ps.rsi), r3: r2(ps.ret3m), r6: r2(ps.ret6m), vol: r2(ps.vol), mdd: r2(ps.mdd),
      ttm: q?.ttm ?? null, ttmG: q?.ttmG ?? null, lastQ: q?.lastQ ?? null, pe: q?.ttm > 0 ? r2(p / q.ttm) : null, lo: r2(p * Math.exp(-z)), hi: r2(p * Math.exp(z)), exp: r2(BETA[h] * (cl(ps.ret6m, -60, 120) - med)), trend: !!(ps.above200 && ps.slope50 > 0), ok: false, why }; })
      .map((x) => { const T = techScore({ r6: x.r6, r3: x.r3, a200: x.a200, slope50: x.slope50, rsi: x.rsi }, REF); return { ...x, T: Math.round(T * 100), G: 0, Q: 0, sc: r2(70 * T) }; }).sort((a, b) => b.sc - a.sc);
    horizons[h] = [...horizons[h].map((x) => ({ ...x, ok: true })), ...ex].slice(0, 60);
  }
  const R = riskScore(U, asof); const low = R.filter((r) => r.cat === 'A' && r.t20 >= 2 && r.ttm > 0 && r.y > 0).sort((a, b) => a.risk - b.risk).slice(0, 10); const high = R.filter((r) => r.t20 >= 1).sort((a, b) => b.risk - a.risk).slice(0, 10);
  const pick = new Set([...horizons[3], ...horizons[6], ...horizons[12]].map((x) => x.c)); low.forEach((x) => pick.add(x.c));
  // Weekly closes for the last year on one shared calendar (raw prices, so they match quoted prices)
  const cal = [...new Set(U.flatMap((u) => u.s.dates.slice(-300)))].sort().filter((d) => d <= asof); const wk = []; for (let k = cal.length - 1; k >= 0 && wk.length < 53; k -= 5) wk.unshift(cal[k]);
  const series = { dates: wk, c: {} }; for (const u of U) if (pick.has(u.code)) series.c[u.code] = wk.map((d) => { const j = idxAt(u.s.dates, d); return j >= 0 ? r2(u.s.raw[j]) : null; });
  const prices = {}; for (const u of U) prices[u.code] = r2(u.s.raw.at(-1));
  const breadth = U.map((u) => priceStats(u.s, u.s.dates.length - 1)).filter(Boolean);
  const monthEnds = (ix) => { const m = {}; for (const [d, c] of ix) if (c > 0) m[d.slice(0, 7)] = c; return Object.entries(m).map(([k, v]) => [k, r2(v)]); };
  // Compact output: per-stock facts once in `stocks`, per-horizon rows as arrays in `cols` order
  const PER = ['sc', 'tot', 'base', 'lo', 'hi', 'dps', 'dnote'], stocks = {};
  for (const h of [3, 6, 12]) horizons[h] = horizons[h].map((x) => { const { c, z, lastQd, exp, ...rest } = x; const row = [c, ...PER.map((k) => rest[k] ?? null)]; PER.forEach((k) => delete rest[k]); stocks[c] = { ...(stocks[c] || {}), ...rest }; return row; });
  for (const c in stocks) for (const k in stocks[c]) if (stocks[c][k] == null || stocks[c][k] === '') delete stocks[c][k];
  for (const u of U) if (pick.has(u.code) && !stocks[u.code]) stocks[u.code] = { n: u.c.name, s: u.c.sector, cat: u.c.cat };
  for (const u of U) if (stocks[u.code]) stocks[u.code].divYrs = Math.min(3, new Set(u.b.acts.filter((x) => x.pub <= asof && x.pub > addDays(asof, -3 * 365) && x.cash > 0).map((x) => x.pub.slice(0, 4))).size);
  // Intrinsic value: 12-month EPS x (1+g)/(r-g), r = policy rate + 6% equity risk premium, g = half of TTM EPS growth capped 0-8%
  const RQ = ((rates && rates.repo) || 9.5) / 100 + 0.06;
  for (const u of U) if (stocks[u.code]) { const t = pvStats(u.s, u.s.dates.length - 1); if (t) Object.assign(stocks[u.code], t); }
  for (const c in stocks) { const s = stocks[c]; if (s.ttm > 0) { const g = Math.max(0, Math.min(0.08, (s.ttmG ?? 0) / 200)); s.iv = r2((s.ttm * (1 + g)) / (RQ - g)); s.mos = r2((s.iv / s.p - 1) * 100); } }
  const secR = {}; for (const c in stocks) if (stocks[c].ok && Number.isFinite(stocks[c].r6)) (secR[stocks[c].s] ||= []).push(stocks[c].r6);
  const secRows = Object.entries(secR).filter(([, v]) => v.length >= 2).map(([k, v]) => [k, r2(median(v)), v.length]).sort((a, b) => b[1] - a[1]);
  const sectors = Object.fromEntries(secRows.map(([k, m, n], i) => [k, { med6: m, n, rank: i + 1, of: secRows.length }]));
  return { asOf: asof, generatedAt: new Date().toISOString(), dsesCount: codes.length, dsesCodes: codes, dsesChange: prevDses.length ? { added: codes.filter((c) => !prevDses.includes(c)), removed: prevDses.filter((c) => !codes.includes(c)) } : null,
    halted: codes.filter((c) => !U.find((u) => u.code === c && u.s.dates.at(-1) >= addDays(asof, -10))),
    market: { dsex: regime(dsex, asof), dses: regime(dses, asof), above200: breadth.length ? Math.round((breadth.filter((b) => b.above200).length / breadth.length) * 100) : null, med3m: r2(median(breadth.map((b) => b.ret3m))), rates, sectorPE: lsec },
    cols: ['c', ...PER], stocks, sectors, ivModel: { required: r2(RQ * 100) }, horizons, positive, low, high, series, prices, monthly: { DSEX: monthEnds(dsex), DSES: monthEnds(dses) } };
}

/* ---------- picks as shown (Signal Desk page rules) ---------- */
// No banks/insurers, no Z category, nothing priced more than 50% above intrinsic value or without one.
// Possible increase = edge vs the average DSES stock (backtest calibration by score quintile) + average dividend in the period.
const EXCL = (s) => /^(Bank|Insurance)$/i.test(s || '');
const OVERPRICED = (x) => !(x.iv > 0) || x.p > 1.5 * x.iv;
export function picksFor(SCAN, BT, h) {
  const cols = SCAN.cols;
  const L = SCAN.horizons[h].map((r) => { const o = {}; cols.forEach((k, i) => (o[k] = r[i])); return { ...SCAN.stocks[o.c], ...o }; }).filter((x) => !EXCL(x.s) && x.cat !== 'Z');
  const cal = BT?.cal?.[h], ok = L.filter((x) => x.ok).sort((a, b) => b.sc - a.sc), n = ok.length;
  const edgeAt = (p) => { if (!cal) return 0; const xs = [0.1, 0.3, 0.5, 0.7, 0.9], ys = cal.iso; if (p <= xs[0]) return ys[0]; if (p >= xs[4]) return ys[4]; for (let k = 0; k < 4; k++) if (p <= xs[k + 1]) return ys[k] + ((ys[k + 1] - ys[k]) * (p - xs[k])) / (xs[k + 1] - xs[k]); return 0; };
  const qOf = (p) => Math.min(4, Math.floor((1 - p) * 5));
  ok.forEach((x, i) => { const p = n > 1 ? 1 - i / (n - 1) : 1; x.edge = edgeAt(p); x.q = qOf(p); });
  const avgDiv = n ? ok.reduce((a, x) => a + (x.dps ? (x.dps / x.p) * 100 : 0), 0) / n : 0;
  for (const x of L) {
    x.divPct = x.dps ? (x.dps / x.p) * 100 : 0;
    if (x.ok) { x.exp = x.edge + avgDiv; x.beat = cal?.beat?.[x.q]; x.upChance = cal?.up?.[x.q]; }
    x.upPct = x.hi != null ? ((x.hi + (x.dps || 0)) / x.p - 1) * 100 : null; x.dnPct = x.lo != null ? ((x.lo + (x.dps || 0)) / x.p - 1) * 100 : null;
  }
  return [...ok.sort((a, b) => b.exp - a.exp || b.sc - a.sc), ...L.filter((x) => !x.ok)].filter((x) => !OVERPRICED(x));
}

/* ---------- track record (history.json logic) ---------- */
function pagePicks(SCAN, hz, n = 20) {
  const st = SCAN.stocks, ix = Object.fromEntries(SCAN.cols.map((k, i) => [k, i])), out = [];
  for (const r of SCAN.horizons[hz]) {
    const s = st[r[0]]; if (!s || !s.ok || EXCL(s.s) || s.cat === 'Z') continue;
    if (!(s.iv > 0) || s.p > 1.5 * s.iv) continue;
    const p = s.p, lo = r[ix.lo], hi = r[ix.hi], dps = r[ix.dps] || 0;
    out.push([r[0], p, r[ix.sc], hi ? r2(((hi + dps) / p - 1) * 100) : null, lo ? r2(((lo + dps) / p - 1) * 100) : null]);
  }
  return out.sort((a, b) => b[2] - a[2]).slice(0, n);
}
/** Adds today's snapshot and, once a week, a frozen snapshot that is never edited. */
export function recordHistory(hist, SCAN) {
  hist.snapshots ||= []; hist.frozen ||= []; hist.results ||= [];
  const snap = { asOf: SCAN.asOf, dses: SCAN.market.dses?.last, dsex: SCAN.market.dsex?.last, picks: Object.fromEntries(['3', '6', '12'].map((k) => [k, pagePicks(SCAN, k).map((x) => x.slice(0, 3))])) };
  hist.snapshots = [...hist.snapshots.filter((s) => s.asOf !== SCAN.asOf), snap].slice(-400);
  const last = hist.frozen.reduce((m, f) => (f.asOf > m ? f.asOf : m), '');
  if (!last || (new Date(SCAN.asOf) - new Date(last)) / 864e5 >= 6) {
    hist.frozen.push({ id: SCAN.asOf, asOf: SCAN.asOf, frozenOn: new Date().toISOString().slice(0, 10), rules: 'DSES only; quality filter; no banks/insurers; no Z category; price <= 1.5x intrinsic value; ranked by combined score',
      dses: SCAN.market.dses?.last, picks: Object.fromEntries(['3', '6', '12'].map((k) => [k, pagePicks(SCAN, k)])) });
  }
  return hist;
}
/** Scores frozen snapshots whose 3/6/12 months have passed (returns include dividends; 1% round-trip cost). */
export function scoreFrozen(hist, U, IDX) {
  const done = new Set((hist.results || []).map((r) => r.key)), idxD = IDX.map((x) => x[0]);
  const today = U.reduce((m, u) => (u.s.dates.at(-1) > m ? u.s.dates.at(-1) : m), '');
  const spear = (a, b) => { const n = a.length; if (n < 5) return null; const rk = (v) => { const o = v.map((x, i) => [x, i]).sort((p, q) => p[0] - q[0]); const r = new Array(n); o.forEach((x, k) => (r[x[1]] = k)); return r; }; const ra = rk(a), rb = rk(b); let s = 0; for (let i = 0; i < n; i++) s += (ra[i] - rb[i]) ** 2; return r2(1 - (6 * s) / (n * (n * n - 1))); };
  for (const f of hist.frozen || []) for (const h of [3, 6, 12]) {
    const key = f.asOf + '|' + h; if (done.has(key)) continue; const mat = addDays(f.asOf, Math.round(h * 30.4)); if (mat > today) continue;
    const i0 = idxAt(idxD, f.asOf), i1 = idxAt(idxD, mat); const idxR = i0 >= 0 && i1 > i0 ? (IDX[i1][1] / IDX[i0][1] - 1) * 100 : null;
    const picks = (f.picks[h] || []).map(([c, , sc, up, dn]) => { const u = U.find((x) => x.code === c); if (!u) return { c, R: null }; const i = idxAt(u.s.dates, f.asOf), j = idxAt(u.s.dates, mat); if (i < 0) return { c, R: null }; const R = j > i ? (u.s.adj[j] / u.s.adj[i] - 1) * 100 : 0; return { c, sc, R: r2(R), above: up != null ? R > up : null, below: dn != null ? R < dn : null }; }).filter((x) => x.R != null);
    if (!picks.length) continue; const top = (n) => picks.slice(0, n), avg = (a) => a.reduce((s, x) => s + x.R, 0) / a.length;
    const res = { key, asOf: f.asOf, h, maturedOn: mat, idx: r2(idxR), n: picks.length, ic: spear(picks.map((x) => x.sc), picks.map((x) => x.R)), above: r2((picks.filter((x) => x.above).length / picks.length) * 100), below: r2((picks.filter((x) => x.below).length / picks.length) * 100), picks: picks.map((x) => [x.c, x.R]) };
    for (const n of [5, 10, 20]) { const t = top(n); if (!t.length) continue; res['ret' + n] = r2(avg(t) - 1); res['hit' + n] = idxR == null ? null : r2((t.filter((x) => x.R - 1 > idxR).length / t.length) * 100); res['ex' + n] = idxR == null ? null : r2(avg(t) - 1 - idxR); }
    hist.results.push(res); done.add(key);
  }
  return hist;
}
