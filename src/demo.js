// Demo data for previewing the app in a browser. Prices are illustrative, NOT real.
const BASE = {
  GP: 300, SQURPHARMA: 215, BATBC: 370, BRACBANK: 52, BEXIMCO: 115, WALTONHIL: 480, ROBI: 28,
  RENATA: 610, LHBL: 62, ISLAMIBANK: 34, BXPHARMA: 95, OLYMPIC: 140, MARICO: 2450, UPGDCL: 160,
  CITYBANK: 22, DUTCHBANGL: 55, EBL: 26, PUBALIBANK: 28, BSRMLTD: 85, SUMITPOWER: 18, ACI: 230,
  BERGERPBL: 1650, UNILEVERCL: 2100, ORIONPHARM: 70, SEAPEARL: 48, BSC: 110, KBPPWBIL: 24,
  IFADAUTOS: 40, NAVANAPHAR: 82, HEIDELBCEM: 230, LANKABAFIN: 18, IDLC: 45, DELTALIFE: 90,
};

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}
const hash = (str) => [...str].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

export function demoQuotes(day) {
  const r = rng(hash(day) + Math.floor(Date.now() / 60000));
  const out = {};
  for (const [code, base] of Object.entries(BASE)) {
    const ycp = +(base * (0.95 + r() * 0.1)).toFixed(1);
    const ltp = +(ycp * (1 + (r() - 0.48) * 0.06)).toFixed(1);
    const change = +(ltp - ycp).toFixed(1);
    const volume = Math.round(20000 + r() * 2e6);
    out[code] = {
      code, ltp, ycp, change, changePct: (change / ycp) * 100,
      high: +(Math.max(ltp, ycp) * (1 + r() * 0.015)).toFixed(1),
      low: +(Math.min(ltp, ycp) * (1 - r() * 0.015)).toFixed(1),
      close: 0, trade: Math.round(volume / 300), value: +((volume * ltp) / 1e6).toFixed(2), volume, _day: day,
    };
  }
  return out;
}

export function demoHistory(q, days) {
  if (!q) return [];
  const r = rng(hash(q.code) + days);
  const rows = [];
  let p = q.ltp;
  const d = new Date();
  for (let i = 0; i < days; i++) {
    const dt = new Date(d.getTime() - i * 864e5);
    const wd = dt.getDay();
    if (wd === 5 || wd === 6) continue; // DSE closed Fri & Sat
    rows.push({ date: dt.toISOString().slice(0, 10), close: +p.toFixed(1), volume: Math.round(50000 + r() * 1.5e6) });
    p = p / (1 + (r() - 0.5) * 0.04);
  }
  return rows.reverse();
}
