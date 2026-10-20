// Screens for the Shariah picks. Texts and rules follow DSE Signal Desk's page (index.html).
import { esc, fmt, pct, cls, dShort } from '../store.js';
import { ic } from '../icons.js';
import { picksFor, addDays } from './engine.js';
import { BT } from './data.js';

const f1 = (x) => (x == null || !isFinite(x) ? '—' : Number(x).toFixed(1));
const dLabel = (s) => (s ? new Date(s + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) : '');
const ago = (d) => (d === 0 ? 'today' : d === 1 ? '1 day ago' : `${d} days ago`);

/* ---------- cached ranking per scan ---------- */
let memo = { scan: null, by: {} };
export function ranked(scan, h) {
  if (!scan) return [];
  if (memo.scan !== scan) memo = { scan, by: {} };
  return (memo.by[h] ||= picksFor(scan, BT, h));
}

/* ---------- texts ---------- */
const XO_DEFS = [
  ['m50200', '50-day vs 200-day avg', 'Golden cross', 'Death cross', '50-day above 200-day', '50-day below 200-day'],
  ['m2050', '20-day vs 50-day avg', '20-day crossed above 50-day', '20-day crossed below 50-day', '20-day above 50-day', '20-day below 50-day'],
  ['p50', 'Price vs 50-day avg', 'Price crossed above 50-day', 'Price crossed below 50-day', 'Price above 50-day', 'Price below 50-day'],
  ['macd', 'MACD vs signal line', 'MACD bullish cross', 'MACD bearish cross', 'MACD above signal', 'MACD below signal'],
];
function xoLine(x, def) {
  const a = x.xo?.[def[0]]; if (!a) return null; const [st, d] = a;
  if (d != null && d <= 10) return { fresh: true, up: st > 0, text: `${st > 0 ? def[2] : def[3]} ${ago(d)}` };
  return { fresh: false, up: st > 0, text: `${st > 0 ? def[4] : def[5]}${d != null ? ` for ${d} days` : ' for over a year'}` };
}
const freshCross = (x) => { for (const def of XO_DEFS) { const l = xoLine(x, def); if (l?.fresh) return l; } return null; };
const pvShort = (x) => (x.pv?.read ? x.pv.read.split(/[:·]/)[0].trim() : null);

function whyText(x) {
  const out = [];
  out.push(`Up ${f1(x.r6)}% over 6 months (dividend-adjusted)` + (x.r3 != null ? `, ${x.r3 >= 0 ? 'up' : 'down'} ${f1(Math.abs(x.r3))}% in the last 3` : '') + '.');
  if (x.trend) out.push('Trend intact: above its 200-day average with the 50-day average rising.');
  else if (x.a200) out.push('Still above its 200-day average, but the 50-day average has turned down, so momentum is fading.');
  else out.push('Below its 200-day average: the 6-month gain is old and the recent trend is down.');
  if (x.qEps != null && x.qEpsLY != null) out.push(`${x.lastQ}: EPS ৳${fmt(x.qEps)} vs ৳${fmt(x.qEpsLY)} a year earlier` + (x.ttmG != null ? `; 12-month EPS ${pct(x.ttmG, 1)}.` : '.'));
  if (x.G != null && x.ok) out.push(x.G >= 65 ? 'Earnings growth is among the best on the list.' : x.G < 35 ? 'Earnings growth is weak, which holds the score back.' : '');
  if (x.Q != null && x.ok) out.push(x.Q >= 65 ? 'Strong cash flow and dividend support.' : x.Q < 35 ? 'Cash flow or dividend support is thin.' : '');
  return out.filter(Boolean).join(' ');
}
function riskText(x, nws) {
  const r = [];
  if (!x.ok) r.push(`Fails the quality filter (${x.why})`);
  if (x.pe > 40) r.push(`priced at ${Math.round(x.pe)}× earnings`);
  if (x.iv != null && x.mos < -50) r.push(`price is ${Math.round((x.p / x.iv) * 100 - 100)}% above its intrinsic value of ৳${fmt(x.iv)}`);
  if (x.vol > 45) r.push(`very volatile (${Math.round(x.vol)}% a year)`);
  if (x.rsi > 70) r.push('overbought on RSI');
  if (x.t20 < 5) r.push(`thin trading (৳${fmt(x.t20)} mn a day)`);
  if (x.cash != null && x.cash < 0 && !/Bank|Insurance/.test(x.s)) r.push('operating cash flow negative this year');
  if (x.ttmG != null && x.ttmG < -30) r.push(`12-month EPS down ${Math.round(-x.ttmG)}%`);
  const bad = (nws || []).find((n) => /halt|query|non-response|qualified|emphasis|suspension of trading|postpone|prohibition on providing loan|reduction of entire paid-up|category change|inspection of (the )?factory|sale (intimation|declaration)|share transfer by a spons/i.test(n[1]));
  if (bad) r.push(`recent notice: "${bad[1]}" (${bad[0]})`);
  if (!r.length) r.push('momentum can reverse quickly when the market turns; use a stop below recent support');
  const s = r.join('; '); return s.charAt(0).toUpperCase() + s.slice(1) + '.';
}
function valueLine(x) {
  if (x.iv == null) return { c: 'bad', t: 'No intrinsic value: not profitable' };
  const m = x.mos;
  const lab = m >= 20 ? ['good', 'Below intrinsic value'] : m >= -20 ? ['near', 'Near intrinsic value'] : m >= -50 ? ['above', 'Above intrinsic value'] : ['bad', 'Far above intrinsic value'];
  return { c: lab[0], t: `<b>${lab[1]}</b> · value ৳${fmt(x.iv)} vs price ৳${fmt(x.p)} (${m >= 0 ? 'margin of safety ' + Math.round(m) + '%' : 'price ' + Math.round((x.p / x.iv) * 100 - 100) + '% above'})` };
}

/* ---------- small chart: a year of weekly closes, then the forecast range ---------- */
function coneChart(scan, x, h) {
  const D = scan.series?.dates, C = scan.series?.c?.[x.c]; if (!D || !C || x.lo == null) return '';
  const W = 320, Hh = 132, pad = { l: 4, r: 52, t: 8, b: 18 };
  const t = (s) => new Date(s + 'T00:00:00Z').getTime(), t0 = t(D[0]), tA = t(scan.asOf), tH = t(addDays(scan.asOf, Math.round(h * 30.4)));
  const p = x.p, endC = p * (1 + (x.edge ?? 0) / 100), steps = 12;
  const cone = Array.from({ length: steps + 1 }, (_, i) => { const f = i / steps; return { tt: tA + (tH - tA) * f, lo: p * Math.pow(x.lo / p, Math.sqrt(f)), hi: p * Math.pow(x.hi / p, Math.sqrt(f)), c: p * Math.pow(endC / p, f) }; });
  const pts = D.map((d, i) => [t(d), C[i]]).filter((q) => q[1] != null);
  const ys = [...pts.map((q) => q[1]), x.lo, x.hi, endC]; let y0 = Math.min(...ys), y1 = Math.max(...ys); const py = (y1 - y0) * 0.06 || 1; y0 -= py; y1 += py;
  const X = (v) => pad.l + ((v - t0) / (tH - t0)) * (W - pad.l - pad.r), Y = (v) => pad.t + (1 - (v - y0) / (y1 - y0)) * (Hh - pad.t - pad.b);
  const lab = (v, s, strong) => `<text x="${X(tH) + 4}" y="${Y(v) + 3}" class="pkf${strong ? ' s' : ''}">${s}</text>`;
  const iv = x.iv > y0 && x.iv < y1 ? `<line x1="${X(tA)}" x2="${X(tH)}" y1="${Y(x.iv)}" y2="${Y(x.iv)}" stroke="var(--faint)" stroke-dasharray="3 3"/>` : '';
  return `<svg class="pkchart" viewBox="0 0 ${W} ${Hh}" role="img" aria-label="${esc(x.c)}: a year of weekly prices, then the ${h}-month range ৳${fmt(x.lo)} to ৳${fmt(x.hi)}">
    <path d="M${cone.map((q) => `${X(q.tt)},${Y(q.hi)}`).join('L')}L${cone.slice().reverse().map((q) => `${X(q.tt)},${Y(q.lo)}`).join('L')}Z" fill="var(--blue)" opacity=".12"/>
    <line x1="${X(tA)}" x2="${X(tA)}" y1="${pad.t}" y2="${Hh - pad.b}" stroke="var(--line)"/>${iv}
    <path d="M${pts.map((q) => `${X(q[0]).toFixed(1)},${Y(q[1]).toFixed(1)}`).join('L')}" fill="none" stroke="var(--blue)" stroke-width="1.7" stroke-linejoin="round"/>
    <path d="M${cone.map((q) => `${X(q.tt)},${Y(q.c)}`).join('L')}" fill="none" stroke="var(--blue)" stroke-width="1.6" stroke-dasharray="4 3"/>
    <circle cx="${X(tA)}" cy="${Y(p)}" r="3" fill="var(--blue)"/>
    ${lab(x.hi, Math.round(x.hi))}${lab(x.lo, Math.round(x.lo))}${Math.abs(Y(endC) - Y(x.hi)) > 10 && Math.abs(Y(endC) - Y(x.lo)) > 10 ? lab(endC, '৳' + Math.round(endC), true) : ''}
    <text x="${X(t0)}" y="${Hh - 4}" class="pkf">${new Date(t0).toLocaleDateString('en-GB', { month: 'short', year: '2-digit' })}</text>
    <text x="${X(tA)}" y="${Hh - 4}" class="pkf" text-anchor="middle">today</text>
    <text x="${X(tH)}" y="${Hh - 4}" class="pkf" text-anchor="end">+${h}m</text></svg>`;
}

/* ---------- one pick ---------- */
function pickRow(scan, x, i, h, st) {
  const open = st.open === x.c;
  const tags = (st.owned.has(x.c) ? '<span class="tag">OWNED</span>' : '') + (st.watched.has(x.c) ? '<span class="tag">WATCH</span>' : '');
  const chips = [];
  const ps = pvShort(x); if (ps) chips.push(`<span class="pkchip ${/Accumulation|buyers/.test(ps) ? 'up' : /Distribution|sellers|Weak/.test(ps) ? 'down' : ''}">${esc(ps)}</span>`);
  const fc = freshCross(x); if (fc) chips.push(`<span class="pkchip ${fc.up ? 'up' : 'down'}">${esc(fc.text)}</span>`);
  if (x.pv?.rv >= 2) chips.push(`<span class="pkchip">Volume ${f1(x.pv.rv)}× today</span>`);
  if (!x.ok) chips.unshift(`<span class="pkchip down">Fails filter: ${esc(x.why)}</span>`);
  const head = `<button class="it pkit" data-a="pk-open" data-v="${esc(x.c)}" aria-expanded="${open}">
    <span class="pkrank n">${i + 1}</span>
    <div class="l"><div class="t">${esc(x.c)}${tags}</div><div class="m">${esc(x.s || '')} · ${esc(x.cat || '')} · score ${Math.round(x.sc)}</div>
      <div class="m n">৳${fmt(x.p)} · up to <b class="up">${pct(x.upPct, 0)}</b> · down to <b class="down">${pct(x.dnPct, 0)}</b></div>
      ${chips.length ? `<div class="pkchips">${chips.join('')}</div>` : ''}</div>
    <div class="r"><div class="p n ${cls(x.exp ?? 0)}">${x.exp != null ? pct(x.exp, 1) : '—'}</div><div class="s muted" style="font-weight:600">possible</div></div></button>`;
  if (!open) return `<div class="pk">${head}</div>`;
  const v = valueLine(x);
  const sec = scan.sectors?.[x.s];
  const nw = st.news[x.c];
  const xo = x.xo ? XO_DEFS.map((def) => { const l = xoLine(x, def); return l ? `<li class="${l.up ? 'up' : 'down'}${l.fresh ? ' fresh' : ''}"><span class="muted">${def[1]}</span><span>${esc(l.text)}</span></li>` : ''; }).join('') : '';
  const sub = [['Technical', x.T], ['Growth', x.G], ['Quality', x.Q]].map(([k, n]) => `<div class="pksub"><span>${k}</span><span class="pkbar"><i style="width:${n ?? 0}%"></i></span><b class="n">${n ?? '—'}</b></div>`).join('');
  const det = `<div class="pkd">
    <div class="grid3">
      <div class="mini"><div class="k">6M move</div><div class="v n ${cls(x.r6)}">${pct(x.r6, 1)}</div></div>
      <div class="mini"><div class="k">P/E</div><div class="v n">${x.pe ? Math.round(x.pe) + '×' : 'loss'}</div></div>
      <div class="mini"><div class="k">Trend</div><div class="v">${x.trend ? 'Up' : x.a200 ? 'Fading' : 'Down'}</div></div>
    </div>
    <div class="pksubs">${sub}</div>
    <div class="pkval ${v.c}">${v.t}</div>
    ${coneChart(scan, x, h)}
    <div class="pkrange n">৳${fmt(x.p)} → <b>৳${fmt(x.lo)}–${fmt(x.hi)}</b> in ${h} months (±1 standard deviation)</div>
    ${x.beat != null ? `<p class="pkp muted">In past tests, ${x.beat}% of stocks in this score group beat the average Shariah stock and ${x.upChance}% rose over ${h} months.</p>` : ''}
    ${x.dnote ? `<div class="pkdiv">${esc(x.dnote)}</div>` : ''}
    <p class="pkp">${esc(whyText(x))}</p>
    <p class="pkp pkrisk">${esc(riskText(x, nw))}</p>
    ${x.pv ? `<div class="pkbox"><div class="pkh">Price &amp; volume</div><p class="pkp" style="margin:0">${esc(x.pv.read)}</p>
      <div class="pkkv n"><span><b>${x.pv.rv != null ? f1(x.pv.rv) + '×' : '—'}</b> volume today</span><span><b>${x.pv.udr != null ? f1(x.pv.udr) : '—'} to 1</b> buy vs sell (20d)</span><span><b>${pct(x.pv.r5, 1)} / ${pct(x.pv.r20, 1)}</b> 5d / 20d</span></div></div>` : ''}
    ${xo ? `<div class="pkbox"><div class="pkh">Crossovers</div><ul class="pkxo n">${xo}</ul><div class="muted" style="font-size:11.5px">20-day ৳${fmt(x.xo.s20)} · 50-day ৳${fmt(x.xo.s50)} · 200-day ৳${fmt(x.xo.s200)}. Context only; not part of the score.</div></div>` : ''}
    <div class="pkbox"><div class="pkh">Recent DSE notices</div>${nw === undefined ? '<div class="muted" style="font-size:12.5px">Loading…</div>' : nw === null ? '<div class="muted" style="font-size:12.5px">Couldn\'t load notices.</div>' : nw.length ? `<ul class="pknews">${nw.map((n) => `<li><span class="n muted">${esc((n[0] || '').slice(5))}</span> ${esc(n[1])}</li>`).join('')}</ul>` : '<div class="muted" style="font-size:12.5px">None in the last 60 days.</div>'}</div>
    <div class="muted" style="font-size:12px">${sec ? `${esc(x.s)} ranks ${sec.rank} of ${sec.of} sectors (median 6M ${pct(sec.med6, 1)}) · ` : ''}${x.divYrs != null ? `cash dividend in ${x.divYrs} of the last 3 years · ` : ''}৳${fmt(x.t20)} mn traded a day · volatility ${Math.round(x.vol)}%/yr</div>
    <div class="grid2" style="gap:8px"><button class="btn ghost sm" data-a="stock" data-v="${esc(x.c)}">Stock page</button><button class="btn ghost sm" data-a="watchtoggle" data-v="${esc(x.c)}">${st.watched.has(x.c) ? 'Watching ✓' : 'Watch'}</button></div>
  </div>`;
  return `<div class="pk open">${head}${det}</div>`;
}

/* ---------- the tab ---------- */
export function picksScreen(st) {
  const { scan, hist, progress: pr, h, n } = st;
  const running = pr.running;
  const head = `<header class="hd"><div><h1>Shariah picks</h1><div class="sub"><span>${scan ? `DSES · close ${esc(dLabel(scan.asOf))} · scored ${esc(new Date(scan.generatedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }))}` : 'DSE Shariah index (DSES)'}</span></div></div>
    ${scan || running ? `<button class="ibtn ${running ? 'spin' : ''}" data-a="pk-update" aria-label="Update picks" ${running ? 'disabled' : ''}>${ic('refresh', 20)}</button>` : ''}</header>`;
  const prog = running ? `<section class="card"><div class="row"><b style="font-size:14px">${scan ? 'Updating picks' : 'Setting up picks'}</b><span class="n muted" style="font-size:12.5px" id="pk-count">${pr.total ? `${pr.done} of ${pr.total}` : ''}</span></div>
    <div class="muted" style="font-size:13px;margin-top:4px" id="pk-step">${esc(pr.step)}</div><div class="progress"><i id="pk-bar" style="width:${pr.total ? Math.round((pr.done / pr.total) * 100) : 4}%"></i></div></section>` : '';
  const err = !running && pr.error ? `<div class="warnbox">Couldn't update picks (${esc(pr.error)}). ${scan ? 'Showing the last scan. ' : ''}<button data-a="pk-update">Try again</button></div>` : '';
  if (!st.native) return head + `<div class="card empty"><b>Picks work in the Android app</b>They are built from DSE, BullBD and LankaBD data, which browsers aren't allowed to read directly.</div>`;
  if (!scan) {
    return head + prog + err + (running ? '' : `<section class="card">
      <div style="display:flex;gap:12px;align-items:flex-start"><span class="ico green">${ic('shield', 20, 2)}</span><div>
      <div style="font-weight:750">Daily ranking of Shariah stocks</div>
      <div class="muted" style="font-size:13px;margin-top:4px;line-height:1.5">Ranks the companies in the DSE Shariah index (DSES) for the next 3, 6 and 12 months, using price trend, earnings growth and cash-flow quality, and checks each against its intrinsic value. Banks, insurers, Z category and overpriced stocks are left out.</div></div></div>
      <div class="info" style="margin:14px 0 0">${ic('download', 18, 2)}<span>The first setup downloads about <b>7 MB</b> (Wi-Fi is best) and takes under a minute. After that the app adds only the newest prices, about 1–2 MB a day, when you open it after the market closes.</span></div>
      <button class="btn" style="margin-top:14px" data-a="pk-update">Set up picks</button></section>
      <p class="note">An analysis aid, not investment advice. In testing, the ranking has not shown provable skill.</p>`);
  }
  const M = scan.market;
  const reg = (name, r) => (r ? `<div class="mini"><div class="k">${name}</div><div class="v n">${fmt(r.last)}</div><div style="margin-top:4px"><span class="pill sm ${r.trend === 'up' ? 'up' : r.trend === 'down' ? 'down' : 'gray'}">${r.trend}</span></div><div class="n muted" style="font-size:11.5px;margin-top:4px">3M ${pct(r.ret3m, 1)}</div></div>` : '');
  const notes = [];
  if (M.rates?.repo) notes.push(`Policy rate ${fmt(M.rates.repo)}%`);
  const ch = scan.dsesChange; if (ch && (ch.added.length || ch.removed.length)) notes.push(`DSES changed: +${ch.added.join(', ') || 'none'}, −${ch.removed.join(', ') || 'none'}`);
  if (scan.halted.length) notes.push(`Not trading: ${scan.halted.join(', ')}`);
  if (M.dses?.trend === 'down') notes.push('Shariah index in a downtrend: buy in stages');
  const market = `<section class="card"><div class="row"><h2>Market</h2><span class="muted" style="font-size:12.5px">${M.above200 ?? '—'}% of DSES above 200-day avg</span></div>
    <div class="grid3" style="margin-top:12px">${reg('DSEX', M.dsex)}${reg('DSES (Shariah)', M.dses)}<div class="mini"><div class="k">Median 3M</div><div class="v n ${cls(M.med3m)}">${pct(M.med3m, 1)}</div><div class="n muted" style="font-size:11.5px;margin-top:4px">DSES stocks</div></div></div>
    ${notes.length ? `<div class="muted" style="font-size:12.5px;margin-top:10px;line-height:1.5">${notes.map(esc).join(' · ')}</div>` : ''}</section>`;
  const all = ranked(scan, h), list = all.slice(0, n);
  const picks = `<div class="row" style="margin:20px 20px 8px"><h2 class="h2" style="font-size:17px;font-weight:800">Top picks</h2><span class="muted" style="font-size:12.5px">${all.filter((x) => x.ok).length} qualify</span></div>
    <div style="margin:0 16px"><div class="seg">${[[3, '3 months'], [6, '6 months'], [12, '12 months']].map(([v, l]) => `<button class="${v === h ? 'on' : ''}" data-a="pk-h" data-v="${v}">${l}</button>`).join('')}</div></div>
    <p class="note" style="margin:10px 20px 10px">Ranked by possible increase over ${h} months: the backtested edge of the stock's score group plus expected dividends, assuming the market stays flat. Tap a stock for details.</p>
    <div class="list">${list.length ? list.map((x, i) => pickRow(scan, x, i, h, st)).join('') : '<div class="empty">No stock passes all the rules today.</div>'}</div>
    ${all.length > n ? `<button class="btn ghost sm" style="margin:12px 16px 0;width:calc(100% - 32px)" data-a="pk-n" data-v="${n + 10}">Show more (${all.length - n} left)</button>` : ''}`;
  const riskRow = (r, steady) => `<button class="it" style="padding:12px 16px" data-a="stock" data-v="${esc(r.c)}"><div class="l"><div class="t">${esc(r.c)}${steady ? '' : `<span class="tag" style="color:var(--down);background:var(--down-bg)">${esc(r.cat)}</span>`}</div>
    <div class="m">${esc(r.s || '')} · vol ${Math.round(r.vol)}% · worst fall ${pct(r.mdd, 0)}${steady ? ` · yield ${fmt(r.y, 1)}%` : r.ttm != null && r.ttm < 0 ? ' · loss-making' : ''}</div></div>
    <div class="r"><div class="p n">${fmt(r.p)}</div><div class="s n"><span class="pkrisk-b"><i style="width:${r.risk}%;background:${r.risk >= 60 ? 'var(--down-mid)' : r.risk >= 25 ? '#F79009' : 'var(--up-mid)'}"></i></span>${r.risk}</div></div></button>`;
  const EX = (s) => /^(Bank|Insurance)$/i.test(s || '');
  const steady = scan.low.filter((r) => !EX(r.s));
  const risky = scan.high.filter((r) => !EX(r.s));
  const lists = `<h2 class="section-t green">Steadiest Shariah stocks</h2><div class="list">${steady.map((r) => riskRow(r, true)).join('')}</div>
    <p class="note" style="margin-top:8px">Lowest risk scores among liquid, profitable, dividend-paying A-category DSES stocks. Lower risk means steadier prices, not guaranteed gains.</p>
    <h2 class="section-t red">High-risk Shariah stocks</h2><div class="list">${risky.map((r) => riskRow(r, false)).join('')}</div>
    <p class="note" style="margin-top:8px">Highest risk scores among DSES stocks trading at least ৳1 mn a day. Any rally in these is speculation, not earnings.</p>`;
  return head + prog + err + market + `<div class="info">${ic('info', 18, 2)}<span><b>Not proven.</b> In testing, about half of the top picks beat the Shariah index after costs, and the ranking did about as well as buying every stock that passed the rules. Use it as a shortlist, not a signal to buy. <button style="color:var(--blue);font-weight:700" data-a="pk-acc">See the evidence</button></span></div>`
    + picks + lists + (st.showAcc ? accuracy(h, hist) : `<button class="linkcard" data-a="pk-acc"><span class="ico purple">${ic('history', 20, 2)}</span><div style="flex:1"><div style="font-weight:750">Accuracy and track record</div><div style="font-size:12.5px;color:var(--muted)">Backtest results and how frozen weekly picks did</div></div><span style="color:var(--faint)">${ic('chev', 18, 2)}</span></button>`)
    + `<p class="note">How it works: covers only DSES companies. Quality filter: A or B category, profitable over the last 12 months, results less than 9 months old, at least ৳2 mn traded a day. Score: 70% technical, 15% earnings growth, 15% cash-flow and dividend quality, each measured against the other DSES stocks. Intrinsic value = 12-month EPS × (1 + g) ÷ (r − g), r = policy rate + 6%. Data: DSE, BullBD, LankaBD, TradingView. Not investment advice.</p>`;
}

function accuracy(h, hist) {
  const A = BT.accuracy, x = A?.horizons?.[h]?.iv?.[A.main || 'noFloor'];
  const row = (k, v, help) => `<div class="pkacc"><div><div style="font-weight:650">${k}</div><div class="muted" style="font-size:12px">${help}</div></div><b class="n">${v}</b></div>`;
  const fr = hist?.frozen || [], R = (hist?.results || []).filter((r) => r.h === h);
  let live;
  if (!R.length) {
    const first = fr[0]?.asOf;
    live = first ? `${fr.length} weekly snapshot${fr.length > 1 ? 's' : ''} frozen so far (first: ${dShort(first)}). Each is scored once ${h} months have passed; the first ${h}-month result is due around ${dShort(addDays(first, Math.round(h * 30.4)))}. Until then the only evidence is the test above.` : 'Weekly snapshots start with the next update.';
  } else {
    const m = (k) => { const v = R.map((r) => r[k]).filter(Number.isFinite); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
    live = `${R.length} matured snapshot${R.length > 1 ? 's' : ''}. Top 10 beat the Shariah index: ${f1(m('hit10'))}% of picks; extra return after costs ${pct(m('ex10'), 1)}; rank accuracy ${fmt(m('ic'))}.${R.length < 6 ? ' Too few to judge yet.' : ''}`;
  }
  return `<section class="card"><h2>Accuracy · ${h}-month holds</h2>
    ${(A?.verdict || []).map((t) => `<p class="pkp">${esc(t)}</p>`).join('')}
    ${x ? `<div style="margin-top:6px">${row('Top 10 beat the DSES index', `${x.hit10}%`, '50% = coin flip')}${row('Extra return vs DSES', pct(x.ex10, 1), 'Average of the top 10 after 1% costs')}${row('vs holding every qualifying stock', pct(x.exAvg10, 1), 'Near zero = ranking added nothing')}${row('Ended above “up to”', `${x.aboveAll}%`, 'Target about 16%')}${row('Ended below “down to”', `${x.belowAll}%`, 'Target about 16%')}${row('Test periods (independent)', `${x.starts} (${x.indep})`, x.indep < 5 ? 'Too few to be sure' : `t = ${fmt(x.tEx10?.t)}; needs about 2 to rule out luck`)}</div>` : ''}
    <div class="pkh" style="margin-top:14px">Live record (frozen weekly picks)</div><p class="pkp">${esc(live)}</p>
    <p class="pkp muted" style="font-size:12px">${esc(A?.method || '')}</p></section>`;
}

/* ---------- pieces for other screens ---------- */
/** Card for the stock page: Shariah status and where the stock ranks. */
export function stockShariahCard(scan, code) {
  if (!scan) return '';
  const inD = scan.dsesCodes.includes(code);
  if (!inD) return `<div class="card tight row" style="gap:12px"><span class="ico warn sm">${ic('shield', 18, 2)}</span><div style="flex:1;font-size:13px;line-height:1.45"><b>Not in the DSE Shariah index</b><br><span class="muted">Not one of the ${scan.dsesCount} DSES companies as of ${dShort(scan.asOf)}.</span></div></div>`;
  const s = scan.stocks[code];
  const ranks = [3, 6, 12].map((h) => { const i = ranked(scan, h).findIndex((x) => x.c === code && x.ok); return i >= 0 ? `#${i + 1} for ${h}M` : null; }).filter(Boolean);
  const risky = scan.high.find((r) => r.c === code);
  const v = s ? valueLine({ ...s, c: code }) : null;
  return `<button class="card tight" style="display:block;width:calc(100% - 32px);text-align:left" data-a="tab" data-v="picks"><div class="row" style="gap:12px;justify-content:flex-start"><span class="ico green sm">${ic('shield', 18, 2)}</span>
    <div style="flex:1;font-size:13px;line-height:1.45"><b>Shariah (DSES)</b> · ${ranks.length ? 'Picks ' + ranks.join(' · ') : 'not in the picks list'}
    ${v ? `<br><span class="muted">${v.t.replace(/<[^>]+>/g, '')}</span>` : ''}${risky ? `<br><span class="down">On the high-risk list (risk ${risky.risk})</span>` : ''}</div><span style="color:var(--faint)">${ic('chev', 18, 2)}</span></div></button>`;
}
/** Warning for the portfolio: holdings outside DSES or on the high-risk list. */
export function portfolioShariah(scan, codes) {
  if (!scan || !codes.length) return '';
  const notD = codes.filter((c) => !scan.dsesCodes.includes(c));
  const risky = codes.filter((c) => scan.high.some((r) => r.c === c));
  if (!notD.length && !risky.length) return `<button class="linkcard" data-a="tab" data-v="picks"><span class="ico green">${ic('shield', 20, 2)}</span><div style="flex:1"><div style="font-weight:750">All holdings are Shariah (DSES)</div><div style="font-size:12.5px;color:var(--muted)">See today's Shariah picks</div></div><span style="color:var(--faint)">${ic('chev', 18, 2)}</span></button>`;
  return `<button class="linkcard" style="background:var(--warn-bg);border-color:#FEDF89" data-a="tab" data-v="picks"><span class="ico warn">${ic('shield', 20, 2)}</span><div style="flex:1;min-width:0"><div style="font-weight:750">Shariah check</div>
    <div style="font-size:12.5px;color:#7A2E0E;line-height:1.45">${notD.length ? `Not in DSES: ${esc(notD.join(', '))}` : ''}${notD.length && risky.length ? '<br>' : ''}${risky.length ? `High-risk list: ${esc(risky.join(', '))}` : ''}</div></div><span style="color:#93370D">${ic('chev', 18, 2)}</span></button>`;
}
