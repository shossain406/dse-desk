// Portfolio math — average-cost method, fees included in cost basis and deducted from proceeds.

export function computePortfolio(trades, quotes = {}) {
  const sorted = [...trades].sort((a, b) => (a.date + a.id).localeCompare(b.date + b.id));
  const pos = {};
  let realizedTotal = 0;
  let feesTotal = 0;
  let dividendsTotal = 0;
  const events = []; // realized gains & dividends, for reports

  for (const t of sorted) {
    const p = (pos[t.code] ||= { code: t.code, qty: 0, cost: 0, realized: 0, dividends: 0, bought: 0, sold: 0 });
    const fee = +t.fee || 0;
    feesTotal += fee;
    if (t.type === 'BUY') {
      p.qty += t.qty;
      p.cost += t.qty * t.price + fee;
      p.bought += t.qty;
    } else if (t.type === 'SELL') {
      const q = Math.min(t.qty, p.qty);
      const avg = p.qty > 0 ? p.cost / p.qty : 0;
      const costOut = avg * q;
      const proceeds = q * t.price - fee;
      const gain = proceeds - costOut;
      p.realized += gain;
      realizedTotal += gain;
      events.push({ date: t.date, code: t.code, type: 'SELL', gain, qty: q, price: t.price });
      p.cost -= costOut;
      p.qty -= q;
      p.sold += q;
      if (p.qty === 0) p.cost = 0;
    } else if (t.type === 'DIV') {
      // Cash dividend: amount stored in price (total BDT), qty unused
      const amt = (+t.price || 0) - fee;
      p.dividends += amt;
      dividendsTotal += amt;
      events.push({ date: t.date, code: t.code, type: 'DIV', gain: amt });
    } else if (t.type === 'BONUS') {
      // Stock dividend: free shares, cost unchanged so average cost falls
      p.qty += t.qty;
    }
  }

  const holdings = [];
  let invested = 0, marketValue = 0, dayChange = 0;
  for (const p of Object.values(pos)) {
    if (p.qty <= 0) continue;
    const q = quotes[p.code];
    const ltp = q && q.ltp > 0 ? q.ltp : (q?.ycp > 0 ? q.ycp : null);
    const avg = p.cost / p.qty;
    const value = ltp != null ? p.qty * ltp : p.cost;
    const unreal = value - p.cost;
    const dc = q && q.ycp > 0 && ltp != null ? p.qty * (ltp - q.ycp) : 0;
    invested += p.cost;
    marketValue += value;
    dayChange += dc;
    holdings.push({
      ...p,
      avg,
      ltp,
      value,
      unreal,
      unrealPct: p.cost > 0 ? (unreal / p.cost) * 100 : 0,
      dayChange: dc,
      dayChangePct: q?.changePct ?? 0,
      hasQuote: ltp != null,
    });
  }
  holdings.sort((a, b) => b.value - a.value);
  holdings.forEach((h) => (h.weight = marketValue > 0 ? (h.value / marketValue) * 100 : 0));

  const unrealized = marketValue - invested;
  return {
    holdings,
    positions: pos,
    events,
    invested,
    marketValue,
    unrealized,
    unrealizedPct: invested > 0 ? (unrealized / invested) * 100 : 0,
    realized: realizedTotal,
    dividends: dividendsTotal,
    fees: feesTotal,
    totalReturn: unrealized + realizedTotal + dividendsTotal,
    dayChange,
    dayChangePct: marketValue - dayChange > 0 ? (dayChange / (marketValue - dayChange)) * 100 : 0,
  };
}

/** Check watchlist alerts against quotes. Returns {fired:[...], watch: updated} */
export function checkAlerts(watch, quotes) {
  const fired = [];
  const next = watch.map((w) => {
    const q = quotes[w.code];
    if (!q || !(q.ltp > 0)) return w;
    const n = { ...w };
    if (w.above > 0) {
      if (q.ltp >= w.above && !w.firedAbove) {
        fired.push({ code: w.code, kind: 'above', target: w.above, ltp: q.ltp });
        n.firedAbove = true;
      } else if (q.ltp < w.above * 0.99) n.firedAbove = false; // re-arm after moving back
    }
    if (w.below > 0) {
      if (q.ltp <= w.below && !w.firedBelow) {
        fired.push({ code: w.code, kind: 'below', target: w.below, ltp: q.ltp });
        n.firedBelow = true;
      } else if (q.ltp > w.below * 1.01) n.firedBelow = false;
    }
    if (w.pct > 0 && Math.abs(q.changePct) >= w.pct && w.firedPctDay !== q._day) {
      fired.push({ code: w.code, kind: 'pct', target: w.pct, ltp: q.ltp, changePct: q.changePct });
      n.firedPctDay = q._day;
    }
    return n;
  });
  return { fired, watch: next };
}
