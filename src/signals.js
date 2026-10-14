// Rule-based buy/sell signals from daily price history.
// rows: [{date, close, volume}] oldest -> newest

export const DEFAULT_RULES = {
  minRules: 2,
  buy: {
    rsiLow: { on: true, v: 30 },
    near52Low: { on: true, v: 5 },
    golden: { on: true },
    volSurge: { on: true, v: 1.5 },
  },
  sell: {
    rsiHigh: { on: true, v: 70 },
    stretched: { on: true, v: 10 },
    trendBreak: { on: true, v: 3 },
    death: { on: false },
  },
  takeProfit: 15,
  stopLoss: 8,
  notify: true,
};

export function mergeRules(r) {
  const d = DEFAULT_RULES;
  r = r || {};
  return {
    minRules: r.minRules ?? d.minRules,
    buy: Object.fromEntries(Object.keys(d.buy).map((k) => [k, { ...d.buy[k], ...(r.buy?.[k] || {}) }])),
    sell: Object.fromEntries(Object.keys(d.sell).map((k) => [k, { ...d.sell[k], ...(r.sell?.[k] || {}) }])),
    takeProfit: r.takeProfit ?? d.takeProfit,
    stopLoss: r.stopLoss ?? d.stopLoss,
    notify: r.notify ?? d.notify,
  };
}

const sma = (arr, n, end = arr.length) => {
  if (end < n) return NaN;
  let s = 0;
  for (let i = end - n; i < end; i++) s += arr[i];
  return s / n;
};

export function rsi(closes, n = 14) {
  if (closes.length < n + 1) return NaN;
  let gain = 0, loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  let ag = gain / n, al = loss / n;
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (n - 1) + Math.max(d, 0)) / n;
    al = (al * (n - 1) + Math.max(-d, 0)) / n;
  }
  if (al === 0) return ag === 0 ? 50 : 100;
  return 100 - 100 / (1 + ag / al);
}

export function indicators(rows) {
  const closes = rows.map((r) => r.close);
  const vols = rows.map((r) => r.volume || 0);
  const n = closes.length;
  const last = closes[n - 1];
  const sma50 = sma(closes, 50);
  const sma200 = sma(closes, 200);
  const yr = closes.slice(-250);
  const low52 = yr.length ? Math.min(...yr) : NaN;
  const high52 = yr.length ? Math.max(...yr) : NaN;
  const vol20 = n > 20 ? sma(vols, 20, n - 1) : NaN; // average of the 20 sessions before today
  const volRatio = vol20 > 0 ? vols[n - 1] / vol20 : NaN;

  // consecutive closes below their 50-day average
  let daysBelow50 = 0;
  for (let i = n; i >= 50; i--) {
    const m = sma(closes, 50, i);
    if (closes[i - 1] < m) daysBelow50++; else break;
  }
  // 50/200 cross within the last 10 sessions
  let cross = null, crossDate = null;
  if (n >= 210) {
    for (let k = 0; k < 10 && !cross; k++) {
      const e = n - k;
      const a = sma(closes, 50, e) - sma(closes, 200, e);
      const b = sma(closes, 50, e - 1) - sma(closes, 200, e - 1);
      if (a > 0 && b <= 0) { cross = 'golden'; crossDate = rows[e - 1].date; }
      if (a < 0 && b >= 0) { cross = 'death'; crossDate = rows[e - 1].date; }
    }
  }
  return {
    last, rsi: rsi(closes), sma50, sma200, low52, high52, vol20, volRatio, daysBelow50, cross, crossDate,
    vs50: sma50 > 0 ? ((last - sma50) / sma50) * 100 : NaN,
    fromLow: low52 > 0 ? ((last - low52) / low52) * 100 : NaN,
    sessions: n,
  };
}

const f1 = (x) => (Math.round(x * 10) / 10).toFixed(1);
const f2 = (x) => x.toFixed(2);
const fmtDate = (d) => new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

/**
 * Evaluate rules for one stock.
 * position: {avg, qty} if held, else null
 * returns { side: 'buy'|'sell'|'watch'|'none', buy:{met,total,reasons}, sell:{...}, own:[], ind }
 */
export function evaluate(rows, rulesIn, position = null) {
  const R = mergeRules(rulesIn);
  if (!rows || rows.length < 20) return { side: 'none', insufficient: true, buy: { met: 0, total: 0, items: [] }, sell: { met: 0, total: 0, items: [] }, own: [] };
  const ind = indicators(rows);
  const buy = [], sell = [], own = [];

  const add = (list, on, ok, text, missText) => {
    if (!on) return;
    list.push({ ok: !!ok, text: ok ? text : missText });
  };
  const b = R.buy, s = R.sell;
  if (isFinite(ind.rsi)) add(buy, b.rsiLow.on, ind.rsi < b.rsiLow.v, `RSI ${Math.round(ind.rsi)} — below ${b.rsiLow.v}, heavily sold`, `RSI ${Math.round(ind.rsi)} — not oversold`);
  if (isFinite(ind.fromLow) && ind.sessions >= 120) add(buy, b.near52Low.on, ind.fromLow <= b.near52Low.v, `${f1(ind.fromLow)}% above its 52-week low (${f2(ind.low52)})`, `${f1(ind.fromLow)}% above its 52-week low`);
  if (ind.sessions >= 210) add(buy, b.golden.on, ind.cross === 'golden', `Golden cross — 50-day average moved above the 200-day on ${ind.crossDate && fmtDate(ind.crossDate)}`, 'No recent golden cross');
  if (isFinite(ind.volRatio)) add(buy, b.volSurge.on, ind.volRatio >= b.volSurge.v, `Volume ${f1(ind.volRatio)}× its 20-day average`, `Volume ${f1(ind.volRatio)}× its 20-day average — no surge`);

  if (isFinite(ind.rsi)) add(sell, s.rsiHigh.on, ind.rsi > s.rsiHigh.v, `RSI ${Math.round(ind.rsi)} — above ${s.rsiHigh.v}, price has risen fast`, `RSI ${Math.round(ind.rsi)} — not overbought`);
  if (isFinite(ind.vs50)) add(sell, s.stretched.on, ind.vs50 > s.stretched.v, `${f1(ind.vs50)}% above its 50-day average (${f2(ind.sma50)})`, `${ind.vs50 >= 0 ? f1(ind.vs50) + '% above' : f1(-ind.vs50) + '% below'} its 50-day average`);
  if (isFinite(ind.sma50)) add(sell, s.trendBreak.on, ind.daysBelow50 >= s.trendBreak.v, `Closed below its 50-day average (${f2(ind.sma50)}) for ${ind.daysBelow50} days`, ind.daysBelow50 > 0 ? `Below its 50-day average for ${ind.daysBelow50} day${ind.daysBelow50 > 1 ? 's' : ''}` : 'Holding above its 50-day average');
  if (ind.sessions >= 210) add(sell, s.death.on, ind.cross === 'death', `Death cross — 50-day average fell below the 200-day on ${ind.crossDate && fmtDate(ind.crossDate)}`, 'No recent death cross');

  let ownHit = false;
  if (position && position.avg > 0) {
    const pnl = ((ind.last - position.avg) / position.avg) * 100;
    const tp = position.avg * (1 + R.takeProfit / 100), sl = position.avg * (1 - R.stopLoss / 100);
    if (pnl >= R.takeProfit) { own.push({ ok: true, text: `Up ${f1(pnl)}% — your take-profit (+${R.takeProfit}%) is reached` }); ownHit = true; }
    else own.push({ ok: false, text: `Take-profit +${R.takeProfit}% triggers at ${f2(tp)}` });
    if (pnl <= -R.stopLoss) { own.push({ ok: true, text: `Down ${f1(-pnl)}% — your stop-loss (−${R.stopLoss}%) is hit` }); ownHit = true; }
    else own.push({ ok: false, text: `Stop-loss −${R.stopLoss}% triggers at ${f2(sl)}` });
  }

  const bm = buy.filter((x) => x.ok).length, sm = sell.filter((x) => x.ok).length;
  let side = 'none';
  if (ownHit || sm >= R.minRules) side = 'sell';
  else if (bm >= R.minRules && !position) side = 'buy';
  else if (bm >= R.minRules && position) side = 'buy';
  else if (sm > 0 || bm > 0) side = 'watch';
  return {
    side,
    buy: { met: bm, total: buy.length, items: buy },
    sell: { met: sm, total: sell.length, items: sell },
    own,
    ind,
  };
}
