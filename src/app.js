import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { App } from '@capacitor/app';
import Chart from 'chart.js/auto';
import { fetchLatest, fetchIndex, fetchHistory, fetchMarketHistory, marketStatus, lastTradeDay, sameAsArchived } from './dse.js';
import { computePortfolio, checkAlerts } from './portfolio.js';
import { evaluate, mergeRules, DEFAULT_RULES } from './signals.js';
import { demoQuotes, demoHistory } from './demo.js';
import { S, setState, save, load, defaults, histGet, histSet, histClear, KEY, esc, fmt, tk, sgn, sgnTk, pct, cls, arrow, today, uid, dShort, dLong, monthName, timeOf, ago, initials, monoColor } from './store.js';
import { ic } from './icons.js';

const isNative = Capacitor.isNativePlatform();
const $ = (s) => document.querySelector(s);
const app = $('#app');

/* =============================== navigation =============================== */
const TABS = ['portfolio', 'market', 'watch', 'insights'];
let stack = [{ name: S.onboarded ? 'portfolio' : 'welcome', p: {} }];
const cur = () => stack[stack.length - 1];
function go(name, p = {}) { cur().y = window.scrollY; stack.push({ name, p }); render(); window.scrollTo(0, 0); }
function tab(name) { stack = [{ name, p: {} }]; render(); window.scrollTo(0, 0); }
function back() {
  if (stack.length > 1) { stack.pop(); render(); window.scrollTo(0, cur().y || 0); }
  else if (cur().name !== 'portfolio' && S.onboarded) tab('portfolio');
  else if (isNative) App.exitApp();
}
function replace(name, p = {}) { stack[stack.length - 1] = { name, p }; render(); window.scrollTo(0, 0); }

/* =============================== ui state =============================== */
const ui = { mMode: 'all', mPer: 'd', mQ: '', tF: 'all', tQ: '', iP: 'year', sF: 'mine', vR: '1M', sR: 90, restoreOpen: false };
let busy = false;
let charts = [];
let mineSig = {}; // code -> evaluate() result
let mineDay = null;
let scanning = null; // { done, total }
let tf = null; // trade form
let af = null; // alert form
let ob = { code: '', qty: '', avg: '' };

/* =============================== helpers =============================== */
function toast(msg, ms = 2800) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), ms);
}
const P = () => computePortfolio(S.trades, S.quotes);
const held = (code) => P().holdings.find((h) => h.code === code);
const allCodes = () => Object.keys(S.quotes).sort();
const codeList = () => `<datalist id="codes">${allCodes().map((c) => `<option value="${esc(c)}">`).join('')}</datalist>`;
const unread = () => S.alertLog.filter((a) => !a.read).length;
function mono(code, size = 40) {
  const [bg, fg] = monoColor(code);
  return `<span class="mono" style="width:${size}px;height:${size}px;background:${bg};color:${fg}">${esc(initials(code))}</span>`;
}
function killCharts() { charts.forEach((c) => c.destroy()); charts = []; }
Chart.defaults.font.family = "'Jakarta', system-ui, sans-serif";
Chart.defaults.color = '#5B6475';
Chart.defaults.borderColor = '#F2F4F7';

function statusLine() {
  const m = marketStatus();
  const label = S.demo ? 'Demo prices' : m.open ? 'Market open' : 'Market closed';
  return `<div class="sub"><span class="dot ${m.open && !S.demo ? 'open' : ''}"></span><span>${label} · ${ago(S.quotesAt)}</span></div>`;
}
function banner() {
  if (S.demo) return `<div class="warnbox">Showing <b>demo prices</b>, not live. <button data-a="refresh">Load live prices</button></div>`;
  if (banner.err) return `<div class="warnbox">${banner.err}</div>`;
  return '';
}
banner.err = '';

/* =============================== data refresh =============================== */
async function refresh({ silent = false } = {}) {
  if (busy) return;
  busy = true;
  document.querySelectorAll('[data-a="refresh"]').forEach((b) => b.classList.add('spin'));
  try {
    const quotes = await fetchLatest();
    const day = lastTradeDay(); // on Fri/Sat or before 10:00 the page still shows the last trading day's prices
    for (const q of Object.values(quotes)) q._day = day;
    S.quotes = quotes;
    S.quotesAt = Date.now();
    S.demo = false;
    banner.err = '';
    fetchIndex().then((ix) => { if (ix) { S.index = ix; save(); if (['portfolio', 'market'].includes(cur().name)) render(); } });
    afterQuotes();
    if (!silent) toast(`Prices updated · ${Object.keys(quotes).length} stocks`);
  } catch (e) {
    banner.err = `Couldn't reach DSE (${esc(e.message)}). ${Object.keys(S.quotes).length && !S.demo ? 'Showing your last saved prices. ' : ''}<button data-a="refresh">Try again</button>${Object.keys(S.quotes).length ? '' : ' · <button data-a="demo">Use demo prices</button>'}`;
  } finally {
    busy = false;
    render();
  }
}

function afterQuotes() {
  const p = P();
  if (p.holdings.length) S.snapshots[today()] = { value: Math.round(p.marketValue), invested: Math.round(p.invested) };
  const keys = Object.keys(S.snapshots).sort();
  if (keys.length > 900) keys.slice(0, keys.length - 900).forEach((k) => delete S.snapshots[k]);
  const { fired, watch } = checkAlerts(S.watch, S.quotes);
  S.watch = watch;
  const now = Date.now();
  fired.forEach((a) => S.alertLog.unshift({ id: uid(), ts: now, ...a, read: false }));
  S.alertLog = S.alertLog.filter((a) => now - a.ts < 90 * 864e5).slice(0, 300);
  save();
  fired.forEach((a) => notify('DSE Desk alert', alertText(a)));
  maybeCloseSummary(p);
  computeMine();
}

function alertText(a) {
  if (a.kind === 'above') return `${a.code} reached your target — traded at ${fmt(a.ltp)}, above ${fmt(a.target)}`;
  if (a.kind === 'below') return `${a.code} hit your stop-loss — traded at ${fmt(a.ltp)}, below ${fmt(a.target)}`;
  return `${a.code} moved ${pct(a.changePct, 1)} today (your alert is ±${fmt(a.target, 1)}%)`;
}

function maybeCloseSummary(p) {
  const m = marketStatus();
  const mins = m.dhaka.getHours() * 60 + m.dhaka.getMinutes();
  if (!S.settings.closeSummary || S.demo || !m.tradingDay || mins < 870 || S.sent.closeSummary === today() || !p.holdings.length) return;
  S.sent.closeSummary = today();
  save();
  notify('Market closed', `Today ${sgnTk(p.dayChange)} (${pct(p.dayChangePct)}) · portfolio ${tk(p.marketValue)}`);
}

async function notify(title, body) {
  if (!S.settings.notify && title === 'DSE Desk alert') return;
  try {
    if (isNative) await LocalNotifications.schedule({ notifications: [{ id: Math.floor(Math.random() * 2e9), title, body }] });
    else if ('Notification' in window && Notification.permission === 'granted') new Notification(title, { body });
  } catch {}
}
async function askNotify() {
  try {
    if (isNative) {
      const c = await LocalNotifications.checkPermissions();
      if (c.display === 'granted') return true;
      return (await LocalNotifications.requestPermissions()).display === 'granted';
    }
    if ('Notification' in window) return (await Notification.requestPermission()) === 'granted';
  } catch {}
  return false;
}

function loadDemo() {
  S.quotes = demoQuotes(today());
  S.quotesAt = Date.now();
  S.demo = true;
  banner.err = '';
  mineDay = null;
  afterQuotes();
  render();
}

/* ---------- history & signals ---------- */
async function getHist(code) {
  const day = today();
  let e = histGet(code);
  if (!e || e.day !== day || e.demo !== S.demo) {
    const rows = S.demo ? demoHistory(S.quotes[code], 400) : await fetchHistory(code, 400);
    e = { day, rows, demo: S.demo };
  }
  e.used = Date.now();
  histSet(code, e);
  return withToday(code, e.rows);
}
function withToday(code, rows) {
  const q = S.quotes[code];
  if (!q || !rows.length || S.demo) return rows;
  const last = rows[rows.length - 1];
  if (q._day && q._day > last.date && q.volume > 0 && !sameAsArchived(q, last.close, last.volume)) return [...rows, { date: q._day, close: q.ltp, volume: q.volume }];
  return rows;
}
const positionOf = (code) => { const h = held(code); return h ? { avg: h.avg, qty: h.qty } : null; };

async function computeMine(force = false) {
  const codes = [...new Set([...P().holdings.map((h) => h.code), ...S.watch.map((w) => w.code)])];
  if (!codes.length || !Object.keys(S.quotes).length) return;
  if (!force && mineDay === today() + S.demo && codes.every((c) => mineSig[c])) return;
  mineDay = today() + S.demo;
  for (const c of codes) {
    try { mineSig[c] = evaluate(await getHist(c), S.rules, positionOf(c)); } catch { /* skip */ }
  }
  const m = marketStatus();
  const mins = m.dhaka.getHours() * 60 + m.dhaka.getMinutes();
  if (S.rules.notify && !S.demo && (!m.tradingDay || mins >= 870) && S.sent.signals !== today()) {
    const sells = codes.filter((c) => mineSig[c]?.side === 'sell' && held(c));
    const buys = codes.filter((c) => mineSig[c]?.side === 'buy');
    if (sells.length || buys.length) {
      S.sent.signals = today();
      save();
      notify('New signals', [sells.length && `Sell: ${sells.join(', ')}`, buys.length && `Buy: ${buys.join(', ')}`].filter(Boolean).join(' · '));
    }
  }
  if (['signals', 'portfolio', 'stock'].includes(cur().name)) render();
}

async function scanMarket() {
  if (scanning) return;
  const codes = allCodes();
  if (!codes.length) return toast('Load prices first');
  scanning = { done: 0, total: codes.length };
  render();
  const results = {};
  let i = 0;
  const worker = async () => {
    while (i < codes.length) {
      const c = codes[i++];
      try {
        const rows = S.demo ? demoHistory(S.quotes[c], 400) : withToday(c, await fetchHistory(c, 400));
        const r = evaluate(rows, S.rules, positionOf(c));
        if (r.side === 'buy' || r.side === 'sell') results[c] = { side: r.side, bm: r.buy.met, bt: r.buy.total, sm: r.sell.met, st: r.sell.total, why: (r.side === 'buy' ? r.buy.items : [...r.own, ...r.sell.items]).filter((x) => x.ok).map((x) => x.text).slice(0, 2) };
      } catch {}
      scanning.done++;
      const bar = $('#scanbar');
      if (bar) { bar.style.width = (scanning.done / scanning.total) * 100 + '%'; $('#scantxt').textContent = `Scanning ${scanning.done} of ${scanning.total}…`; }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  S.scan = { day: today(), at: Date.now(), total: codes.length, results };
  save();
  scanning = null;
  render();
  toast(`Scan done · ${Object.values(results).filter((r) => r.side === 'buy').length} buy, ${Object.values(results).filter((r) => r.side === 'sell').length} sell signals`);
}

/* =============================== shared pieces =============================== */
function nav(active) {
  const t = (name, label, icon) => `<button class="tab ${active === name ? 'on' : ''}" data-a="tab" data-v="${name}" ${active === name ? 'aria-current="page"' : ''}>${ic(icon, 22)}${label}</button>`;
  return `<nav class="nav" aria-label="Main">${t('portfolio', 'Portfolio', 'pie')}${t('market', 'Market', 'trend')}
    <button data-a="newtrade" aria-label="Add trade"><span class="fabc">${ic('plus', 24, 2.4)}</span></button>
    ${t('watch', 'Watchlist', 'eye')}${t('insights', 'Insights', 'bars')}</nav>`;
}
const bar = (title, { close = false, right = '', center = false } = {}) =>
  `<div class="bar"><button class="back" data-a="back" aria-label="${close ? 'Close' : 'Back'}">${ic(close ? 'close' : 'back', 22, 2)}</button>
   <h1 ${center ? 'class="center"' : ''}>${title}</h1>${right || (center ? '<span style="width:44px"></span>' : '')}</div>`;
const sw = (on, a, label, extra = '') => `<button class="sw ${on ? 'on' : ''}" data-a="${a}" ${extra} role="switch" aria-checked="${on}" aria-label="${esc(label)}"></button>`;
const seg = (opts, val, a) => `<div class="seg">${opts.map(([v, l]) => `<button class="${String(v) === String(val) ? 'on' : ''}" data-a="${a}" data-v="${v}">${l}</button>`).join('')}</div>`;
const chip = (v, l, on, a) => `<button class="chip ${on ? 'on' : ''}" data-a="${a}" data-v="${v}">${l}</button>`;
const reasonLi = (r, color) => `<li class="${r.ok ? '' : 'miss'}">${r.ok ? `<span style="color:${color}">${ic('check', 16, 2.6)}</span>` : `<span style="color:#98A2B3">${ic('minus', 16, 2.4)}</span>`}<span class="n">${esc(r.text)}</span></li>`;
const score = (met, total, color) => `<div class="score" aria-label="${met} of ${total} rules met">${Array.from({ length: total }, (_, i) => `<i style="${i < met ? `background:${color}` : ''}"></i>`).join('')}</div>`;

/* =============================== onboarding =============================== */
function vWelcome() {
  return { raw: true, html: `<div class="ob">
    <div style="display:flex;align-items:center;gap:10px"><span class="ico" style="width:36px;height:36px;border-radius:11px;background:var(--blue);color:#fff">${ic('logo', 20, 2.4)}</span><span style="font-weight:800;font-size:18px">DSE Desk</span></div>
    <div style="margin-top:30px;background:#F5F8FF;border-radius:28px;padding:22px 20px 18px">
      <div style="background:#fff;border-radius:18px;padding:16px;box-shadow:0 10px 30px rgba(29,78,216,.10)">
        <div class="lbl">Total value</div><div style="height:14px;width:150px;border-radius:7px;background:var(--ink);margin-top:8px"></div>
        <svg viewBox="0 0 280 70" width="100%" height="70" style="display:block;margin-top:12px" aria-hidden="true"><path d="M0 58 C20 54 34 60 54 50 S90 36 112 42 S150 52 172 36 S220 16 280 10 L280 70 L0 70 Z" fill="#1D4ED8" fill-opacity="0.10"/><path d="M0 58 C20 54 34 60 54 50 S90 36 112 42 S150 52 172 36 S220 16 280 10" fill="none" stroke="#1D4ED8" stroke-width="2.6" stroke-linecap="round"/></svg>
      </div>
    </div>
    <h1 style="font-size:28px;line-height:1.18;margin-top:28px">Your DSE portfolio,<br>always up to date</h1>
    <p class="lead">Track what you own, see profit and loss in taka, and get told when a stock hits your price.</p>
    <ul style="list-style:none;padding:0;margin:20px 0 0;display:flex;flex-direction:column;gap:14px;font-size:14.5px;font-weight:600">
      <li style="display:flex;gap:12px;align-items:center"><span class="ico sm blue">${ic('refresh', 18, 2)}</span>Live prices from dsebd.org every minute</li>
      <li style="display:flex;gap:12px;align-items:center"><span class="ico sm green">${ic('pie', 18, 2)}</span>Profit, dividends and fees on every holding</li>
      <li style="display:flex;gap:12px;align-items:center"><span class="ico sm warn">${ic('bell', 18, 2)}</span>Alerts and buy/sell signals you control</li>
    </ul>
    <div style="flex:1;min-height:20px"></div>
    <div class="steps"><i class="on"></i><i></i><i></i></div>
    <button class="btn" data-a="ob" data-v="setup">Get started</button>
    <button class="btn text" data-a="ob-restore">I have a backup to restore</button>
  </div>` };
}
function vSetup() {
  const c = S.settings.commissionPct;
  return { raw: true, html: `<div class="ob">
    <div class="row"><button class="back" style="margin-left:-10px" data-a="ob" data-v="welcome" aria-label="Back">${ic('back', 22, 2)}</button><span style="font-size:13px;font-weight:700;color:var(--muted)">Step 2 of 3</span><span style="width:44px"></span></div>
    <h1>Two quick settings</h1>
    <p class="lead">These make your profit numbers exact. You can change them later in Settings.</p>
    <section style="margin-top:24px;border:1px solid var(--line);border-radius:20px;padding:18px">
      <h2 class="h2" style="font-size:16px">Broker commission</h2>
      <p style="margin:4px 0 0;font-size:13.5px;color:var(--muted);line-height:1.45">Added to every buy and taken from every sell. Check your broker's contract note.</p>
      <div class="field"><label for="ob-comm">Rate per trade (%)</label><input id="ob-comm" class="inp big n" inputmode="decimal" value="${c}"></div>
      <div style="display:flex;gap:8px;margin-top:12px">${[0.3, 0.4, 0.5].map((v) => `<button class="chip pick ${v === c ? 'on' : ''}" style="flex:1" data-a="ob-comm" data-v="${v}">${v.toFixed(2)}%</button>`).join('')}</div>
      <div class="n" style="margin-top:12px;font-size:13px;color:var(--muted);background:var(--soft);border-radius:10px;padding:10px 12px">Example: buying ৳50,000 of shares costs <b style="color:var(--ink)" id="ob-ex">${tk(50000 * c / 100)}</b> in commission.</div>
    </section>
    <section style="margin-top:14px;border:1px solid var(--line);border-radius:20px;padding:18px;display:flex;gap:14px">
      <span class="ico warn">${ic('bell', 20, 2)}</span>
      <div style="flex:1"><h2 class="h2" style="font-size:16px">Price alerts</h2>
        <p style="margin:4px 0 0;font-size:13.5px;color:var(--muted);line-height:1.45">Allow notifications so the app can tell you when a stock hits your target or stop-loss.</p>
        <button class="tbtn" style="margin-top:12px;min-height:44px;font-size:14px" data-a="ob-notify" id="ob-notify">Allow notifications</button></div>
    </section>
    <div style="flex:1;min-height:20px"></div>
    <div class="steps"><i></i><i class="on"></i><i></i></div>
    <button class="btn" data-a="ob" data-v="first">Continue</button>
  </div>`, after() {
    $('#ob-comm').addEventListener('input', (e) => { const v = parseFloat(e.target.value); if (v >= 0) { S.settings.commissionPct = v; save(); $('#ob-ex').textContent = tk(50000 * v / 100); } });
  } };
}
function obSummary() {
  const q = S.quotes[ob.code];
  const qty = +ob.qty, avg = +ob.avg;
  if (!(ob.code && qty > 0 && avg > 0)) return 'Fill in the code, shares and average price.';
  const cost = qty * avg;
  if (!q) return `<div class="row"><span>Cost</span><b style="color:var(--ink)">${tk(cost)}</b></div>${Object.keys(S.quotes).length ? `<div style="margin-top:6px">${esc(ob.code)} isn't in today's DSE price list — check the code.</div>` : ''}`;
  const val = qty * q.ltp;
  return `<div class="row"><span>Cost</span><b style="color:var(--ink)">${tk(cost)}</b></div>
    <div class="row" style="margin-top:6px"><span>Value now (LTP ${fmt(q.ltp)})</span><b style="color:var(--ink)">${tk(val)}</b></div>
    <div class="row" style="margin-top:6px"><span>Unrealized profit</span><b class="${cls(val - cost)}">${sgnTk(val - cost)} · ${pct(((val - cost) / cost) * 100)}</b></div>`;
}
function vFirst() {
  const ok = ob.code && +ob.qty > 0 && +ob.avg > 0;
  return { raw: true, html: `<div class="ob">
    <div class="row"><button class="back" style="margin-left:-10px" data-a="ob" data-v="setup" aria-label="Back">${ic('back', 22, 2)}</button><span style="font-size:13px;font-weight:700;color:var(--muted)">Step 3 of 3</span><button class="tbtn link" data-a="ob-done">Skip</button></div>
    <h1>Add a stock you own</h1>
    <p class="lead">Enter what you hold today at your average price. You can add the full trade history later.</p>
    <div class="field"><label for="ob-code">Trading code</label><input id="ob-code" class="inp" list="codes" autocapitalize="characters" autocomplete="off" placeholder="e.g. GP" value="${esc(ob.code)}">${codeList()}</div>
    <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:10px">${['GP', 'SQURPHARMA', 'BATBC', 'BRACBANK', 'BEXIMCO'].map((c) => `<button class="chip pick sm ${ob.code === c ? 'on' : ''}" data-a="ob-pick" data-v="${c}">${c}</button>`).join('')}</div>
    <div class="grid2" style="gap:12px">
      <div class="field"><label for="ob-qty">Shares held</label><input id="ob-qty" class="inp n" inputmode="numeric" value="${esc(ob.qty)}"></div>
      <div class="field"><label for="ob-avg">Average buy price (৳)</label><input id="ob-avg" class="inp n" inputmode="decimal" value="${esc(ob.avg)}"></div>
    </div>
    <div id="ob-sum" class="n" style="margin-top:16px;background:var(--soft);border-radius:16px;padding:14px 16px;font-size:13.5px;color:var(--muted)">${obSummary()}</div>
    <div style="flex:1;min-height:20px"></div>
    <div class="steps"><i></i><i></i><i class="on"></i></div>
    <button class="btn" data-a="ob-add" ${ok ? '' : 'disabled'}>Add and open portfolio</button>
    <button class="btn text" data-a="ob-add" data-v="more" ${ok ? '' : 'disabled'}>Add and enter another</button>
  </div>`, after() {
    // update in place while typing — never re-render, so focus and typed text are kept
    const upd = () => {
      ob.code = $('#ob-code').value.trim().toUpperCase(); ob.qty = $('#ob-qty').value; ob.avg = $('#ob-avg').value;
      const ok = ob.code && +ob.qty > 0 && +ob.avg > 0;
      document.querySelectorAll('[data-a="ob-add"]').forEach((b) => (b.disabled = !ok));
      document.querySelectorAll('[data-a="ob-pick"]').forEach((b) => b.classList.toggle('on', b.dataset.v === ob.code));
      $('#ob-sum').innerHTML = obSummary();
    };
    ['#ob-code', '#ob-qty', '#ob-avg'].forEach((s) => { $(s).addEventListener('input', upd); $(s).addEventListener('change', upd); });
  } };
}

/* =============================== portfolio =============================== */
function vPortfolio() {
  const p = P();
  const head = `<header class="hd"><div><h1>Portfolio</h1>${statusLine()}</div><div class="hd-btns">
    <button class="ibtn" data-a="go" data-v="alerts" aria-label="Alerts${unread() ? `, ${unread()} new` : ''}">${ic('bell', 20, 1.8)}${unread() ? `<span class="badge n">${unread()}</span>` : ''}</button>
    <button class="ibtn" data-a="go" data-v="settings" aria-label="Settings">${ic('sliders', 20, 1.8)}</button></div></header>${banner()}`;
  if (!S.trades.length) {
    return { nav: 'portfolio', html: head + `<div class="card empty"><b>No holdings yet</b>Record a buy, or add a stock you already own with its average price.<br><br><button class="btn sm" style="width:auto;padding:0 18px;margin:0 auto" data-a="newtrade">Add a trade</button></div>${indexCard()}` };
  }
  const missing = p.holdings.filter((h) => !h.hasQuote).map((h) => h.code);
  const sig = sigSummary();
  const colors = ['#1D4ED8', '#F79009', '#6CA0F5', '#7A2E0E', '#12B76A', '#9E77ED', '#98A2B3'];
  const top = p.holdings.slice(0, 6);
  const rest = p.holdings.slice(6).reduce((s, h) => s + h.weight, 0);
  const alloc = top.map((h, i) => ({ code: h.code, w: h.weight, c: colors[i] })).concat(rest > 0 ? [{ code: 'Others', w: rest, c: colors[6] }] : []);
  return { nav: 'portfolio', html: head + `
    <section class="card" style="margin-top:4px;padding:18px 18px 14px">
      <div class="lbl" style="font-size:13px">Total value</div>
      <div class="big n">${tk(p.marketValue, 2)}</div>
      <div style="display:flex;align-items:center;gap:8px;margin-top:6px"><span class="pill ${cls(p.dayChange)} n">${arrow(p.dayChange)}${tk(Math.abs(p.dayChange), 2)} (${pct(p.dayChangePct)})</span><span style="font-size:13px;color:var(--muted)">today</span></div>
      <div class="chart sm"><canvas id="c-val"></canvas></div><div id="val-empty" class="muted" style="font-size:12.5px"></div>
      <div style="margin-top:10px">${seg([['1W', '1W'], ['1M', '1M'], ['3M', '3M'], ['1Y', '1Y'], ['All', 'All']], ui.vR, 'vrange')}</div>
    </section>
    <section class="grid2 stats">
      <div class="stat"><div class="lbl">Invested</div><div class="v n">${tk(p.invested)}</div></div>
      <div class="stat"><div class="lbl">Unrealized P/L</div><div class="v n ${cls(p.unrealized)}">${sgnTk(p.unrealized)}</div><div class="n ${cls(p.unrealized)}" style="font-size:12px;font-weight:600">${pct(p.unrealizedPct)}</div></div>
      <div class="stat"><div class="lbl">Realized P/L</div><div class="v n ${cls(p.realized)}">${sgnTk(p.realized)}</div></div>
      <div class="stat"><div class="lbl">Dividends</div><div class="v n">${tk(p.dividends)}</div></div>
    </section>
    <button class="linkcard blue" data-a="tab" data-v="insights">
      <div style="flex:1"><div style="font-size:12.5px;color:#3538CD;font-weight:700">Total return</div><div class="n" style="font-size:13px;color:var(--ink-2);margin-top:2px">Unrealized + realized + dividends, after ${tk(p.fees)} fees</div></div>
      <span class="n ${cls(p.totalReturn)}" style="font-size:17px;font-weight:800">${sgnTk(p.totalReturn)}</span><span style="color:#3538CD">${ic('chev', 18, 2)}</span>
    </button>
    <button class="linkcard" data-a="go" data-v="signals">
      <span class="ico purple">${ic('pulse', 20, 2)}</span>
      <div style="flex:1;min-width:0"><div style="font-weight:750">Signals</div><div style="font-size:12.5px;color:var(--muted)">${sig.text}</div></div>
      ${sig.count ? `<span class="n" style="min-width:24px;height:24px;padding:0 6px;border-radius:12px;background:var(--purple);color:#fff;font-size:12px;font-weight:750;display:grid;place-items:center">${sig.count}</span>` : `<span style="color:var(--faint)">${ic('chev', 18, 2)}</span>`}
    </button>
    ${missing.length ? `<div class="warnbox">No live price for ${esc(missing.join(', '))} — valued at cost. Check the trading code.</div>` : ''}
    <section class="card">
      <div class="row"><h2>Allocation</h2><span style="font-size:12.5px;color:var(--muted)">by market value</span></div>
      <div class="stack">${alloc.map((a) => `<div style="width:${a.w}%;background:${a.c}"></div>`).join('')}</div>
      <div class="legend">${alloc.map((a) => `<div><span class="sq" style="background:${a.c}"></span><span style="flex:1;font-weight:600;overflow:hidden;text-overflow:ellipsis">${esc(a.code)}</span><span class="n muted">${fmt(a.w, 1)}%</span></div>`).join('')}</div>
    </section>
    ${indexCard()}
    <div class="row" style="margin:20px 20px 10px"><h2 class="h2" style="font-size:17px;font-weight:800">Holdings <span class="muted" style="font-weight:600">· ${p.holdings.length}</span></h2></div>
    <div class="list">${p.holdings.map((h) => `<button class="it" data-a="stock" data-v="${esc(h.code)}">${mono(h.code)}
      <div class="l"><div class="t">${esc(h.code)}</div><div class="m n">${fmt(h.qty, 0)} sh · avg ${fmt(h.avg)}</div></div>
      <div class="r"><div class="p n">${tk(h.value)}</div><div class="s n ${cls(h.unreal)}">${sgnTk(h.unreal)} · ${pct(h.unrealPct, 1)}</div></div></button>`).join('')}</div>
    <button class="btn ghost sm" style="margin:12px 16px 0;width:calc(100% - 32px)" data-a="go" data-v="trades">View all trades ${ic('chev', 16, 2)}</button>`,
  after: () => valueChart() };
}

function sigSummary() {
  const codes = [...new Set([...P().holdings.map((h) => h.code), ...S.watch.map((w) => w.code)])];
  const sells = codes.filter((c) => mineSig[c]?.side === 'sell' && held(c)).length;
  const buys = codes.filter((c) => mineSig[c]?.side === 'buy').length;
  if (!Object.keys(mineSig).length) return { count: 0, text: 'Rule-based buy and sell signals' };
  const parts = [];
  if (sells) parts.push(`${sells} sell signal${sells > 1 ? 's' : ''} on your holdings`);
  if (buys) parts.push(`${buys} buy idea${buys > 1 ? 's' : ''}`);
  return { count: sells + buys, text: parts.join(' · ') || 'No signals on your stocks today' };
}

function indexCard() {
  if (!S.index || S.demo) return '';
  const i = S.index;
  return `<button class="linkcard" data-a="tab" data-v="market"><div style="flex:1"><div class="lbl">DSEX index</div><div class="n" style="font-size:17px;font-weight:750">${fmt(i.value)}</div></div>
    ${isFinite(i.change) ? `<span class="pill ${cls(i.change)} n">${arrow(i.change)}${fmt(Math.abs(i.change))}${isFinite(i.changePct) ? ` (${pct(i.changePct)})` : ''}</span>` : ''}</button>`;
}

function valueChart() {
  const el = $('#c-val');
  if (!el) return;
  const days = { '1W': 7, '1M': 30, '3M': 90, '1Y': 365, All: 1e5 }[ui.vR];
  const from = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  const snaps = Object.entries(S.snapshots).filter(([d]) => d >= from).sort(([a], [b]) => a.localeCompare(b));
  if (snaps.length < 2) {
    el.parentElement.style.display = 'none';
    $('#val-empty').textContent = 'The app saves one snapshot a day when prices refresh. This chart fills in after a couple of trading days.';
    return;
  }
  const up = snaps[snaps.length - 1][1].value >= snaps[snaps.length - 1][1].invested;
  charts.push(new Chart(el, {
    type: 'line',
    data: { labels: snaps.map(([d]) => d), datasets: [
      { label: 'Value', data: snaps.map(([, s]) => s.value), borderColor: '#1D4ED8', borderWidth: 2.4, pointRadius: 0, tension: 0.3, fill: true,
        backgroundColor: (c) => { const g = c.chart.ctx.createLinearGradient(0, 0, 0, 150); g.addColorStop(0, 'rgba(29,78,216,.18)'); g.addColorStop(1, 'rgba(29,78,216,0)'); return g; } },
      { label: 'Cost', data: snaps.map(([, s]) => s.invested), borderColor: '#98A2B3', borderDash: [4, 4], borderWidth: 1.4, pointRadius: 0 },
    ] },
    options: chartOpts({ legend: false, money: true }),
  }));
  void up;
}

function chartOpts({ legend = false, money = false } = {}) {
  return {
    maintainAspectRatio: false, animation: { duration: 250 },
    interaction: { mode: 'index', intersect: false },
    plugins: { legend: { display: legend }, tooltip: { backgroundColor: '#101828', padding: 10, callbacks: { title: (it) => dLong(it[0].label), label: (c) => `${c.dataset.label}: ${c.dataset.label === 'Volume' ? fmt(c.raw, 0) : money ? tk(c.raw) : fmt(c.raw)}` } } },
    scales: {
      x: { grid: { display: false }, border: { display: false }, ticks: { maxTicksLimit: 4, maxRotation: 0, callback(v) { const l = this.getLabelForValue(v); return /^\d{4}-\d\d-\d\d$/.test(l) ? dShort(l) : l; } } },
      y: { position: 'right', border: { display: false }, grid: { color: '#F2F4F7' }, ticks: { maxTicksLimit: 4, callback: (v) => (money ? (v >= 1e5 ? fmt(v / 1e5, 2) + 'L' : fmt(v / 1e3, 0) + 'k') : fmt(v, v >= 1000 ? 0 : 1)) } },
    },
  };
}

/* =============================== market =============================== */
function vMarket() {
  const all = Object.values(S.quotes);
  const m = marketStatus();
  const head = `<header class="hd"><div><h1>Market</h1><div class="sub"><span class="dot ${m.open && !S.demo ? 'open' : ''}"></span><span>${S.demo ? 'Demo prices' : m.open ? 'DSE · open until 2:30 pm' : `DSE · closed${shownDay() ? ` · showing ${shownDay()}` : ''}`} · ${ago(S.quotesAt)}</span></div></div>
    <button class="ibtn ${busy ? 'spin' : ''}" data-a="refresh" aria-label="Refresh prices">${ic('refresh', 20)}</button></header>${banner()}`;
  if (!all.length) return { nav: 'market', html: head + `<div class="card empty"><b>No prices yet</b>Tap refresh to load the latest DSE prices.<br><br><button class="btn sm" style="width:auto;padding:0 18px;margin:0 auto" data-a="refresh">Load prices</button></div>` };
  const adv = all.filter((q) => q.change > 0).length, dec = all.filter((q) => q.change < 0).length, same = all.length - adv - dec;
  const turnover = all.reduce((s, q) => s + (q.value || 0), 0);
  const ix = S.index && !S.demo ? S.index : null;
  return { nav: 'market', html: head + `
    <section class="card" style="margin-top:4px">
      ${ix ? `<div class="row" style="align-items:flex-start"><div><div class="lbl" style="font-size:13px">DSEX index</div><div class="n" style="font-size:26px;font-weight:800;letter-spacing:-.4px">${fmt(ix.value)}</div></div>${isFinite(ix.change) ? `<span class="pill ${cls(ix.change)} n">${arrow(ix.change)}${fmt(Math.abs(ix.change))}${isFinite(ix.changePct) ? ` (${pct(ix.changePct)})` : ''}</span>` : ''}</div><div style="height:1px;background:var(--line-2);margin:14px 0"></div>` : ''}
      <div class="row n" style="font-size:12.5px;font-weight:700"><span class="up">▲ ${adv} up</span><span class="muted">${same} same</span><span class="down">${dec} down ▼</span></div>
      <div class="stack" style="height:8px;margin-top:8px"><div style="width:${(adv / all.length) * 100}%;background:var(--up-mid)"></div><div style="width:${(same / all.length) * 100}%;background:#D0D5DD"></div><div style="width:${(dec / all.length) * 100}%;background:var(--down-mid)"></div></div>
      <div class="row" style="margin-top:12px;font-size:13px"><span class="muted">Turnover</span><span class="n" style="font-weight:750">৳${fmt(turnover / 10, 1)} crore</span></div>
    </section>
    <div class="search">${ic('search', 18, 2, 'style="color:#667085"')}<input id="mq" placeholder="Search ${all.length} stocks" value="${esc(ui.mQ)}" autocapitalize="characters" autocomplete="off" aria-label="Search trading code"></div>
    <div class="chips">${[['all', 'All'], ['gain', 'Gainers'], ['lose', 'Losers'], ['value', 'Top value'], ['volume', 'Volume']].map(([v, l]) => chip(v, l, ui.mMode === v, 'mmode')).join('')}</div>
    ${ui.mMode !== 'all' ? `<div style="margin:12px 16px 0">${seg([['d', 'Daily'], [5, 'Weekly (5)'], [15, '15 days'], [18, '18 days']], ui.mPer, 'mper')}</div>` : ''}
    <div class="row" style="margin:16px 20px 8px;font-size:12px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px"><span>Stock</span><span>Last price · ${ui.mMode !== 'all' && ui.mPer !== 'd' ? `${ui.mPer}-day change` : 'change'}</span></div>
    <div class="list" id="mlist"></div>`,
  after() { fillMarket(); $('#mq').addEventListener('input', (e) => { ui.mQ = e.target.value; fillMarket(); }); } };
}

/* ---- multi-day top lists (Weekly / 15 / 18 trading days), built from the whole-market day-end archive ---- */
const PER_KEY = 'dsedesk.period';
let per = (() => { try { return JSON.parse(localStorage.getItem(PER_KEY)); } catch { return null; } })(); // { day, at, demo, by: { CODE: [[date, close, ycp, value, volume]] } }
let perLoad = null; // { done, total } while downloading
let perErr = '';
const perFresh = () => per && per.demo === S.demo && per.day === today() && Date.now() - per.at < 3 * 3600e3;

async function loadPeriod() {
  if (perLoad || perFresh()) return;
  perLoad = { done: 0, total: 5 };
  perErr = '';
  try {
    let by;
    if (S.demo) {
      by = {};
      for (const q of Object.values(S.quotes)) {
        const h = demoHistory(q, 35);
        by[q.code] = h.map((r, i) => ({ ...r, ycp: i ? h[i - 1].close : r.close, value: (r.close * r.volume) / 1e6 }));
      }
    } else {
      by = await fetchMarketHistory(35, (done, total) => { perLoad = { done, total }; if (cur().name === 'market') fillMarket(); });
    }
    const compact = {};
    for (const [code, rows] of Object.entries(by)) compact[code] = rows.map((r) => [r.date, r.close, r.ycp, r.value || 0, r.volume || 0]);
    per = { day: today(), at: Date.now(), demo: S.demo, by: compact };
    try { localStorage.setItem(PER_KEY, JSON.stringify(per)); } catch {}
  } catch (e) {
    perErr = e.message || 'unknown error';
  } finally {
    perLoad = null;
    if (cur().name === 'market') fillMarket();
  }
}

/** Change, value and volume over the last n trading days, with today's live prices added if the archive doesn't have today yet */
function periodStat(q, n) {
  let rows = per?.by[q.code];
  if (!rows?.length) return null;
  const last = rows[rows.length - 1];
  if (q._day && q._day > last[0] && q.volume > 0 && !sameAsArchived(q, last[1], last[4])) rows = [...rows, [q._day, q.ltp, q.ycp, q.value || 0, q.volume]];
  const span = rows.slice(-n);
  const base = span[0][2] > 0 ? span[0][2] : span[0][1];
  const close = span[span.length - 1][1];
  return {
    ...q,
    changePct: base > 0 ? (close / base - 1) * 100 : 0,
    change: close - base,
    value: span.reduce((s, r) => s + r[3], 0),
    volume: span.reduce((s, r) => s + r[4], 0),
  };
}

/** Trading day of the prices on screen, e.g. "Thu 15 Oct" (shown while the market is closed) */
function shownDay() {
  const d = Object.values(S.quotes)[0]?._day;
  return d ? new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) : '';
}

function fillMarket() {
  const box = $('#mlist');
  if (!box) return;
  const m = ui.mMode;
  const n = m !== 'all' && ui.mPer !== 'd' ? +ui.mPer : 0;
  let list = Object.values(S.quotes);
  if (n) {
    if (!perFresh() && !perErr) loadPeriod();
    if (perLoad || (!perFresh() && !per)) {
      const p = perLoad || { done: 0, total: 5 };
      box.innerHTML = `<div class="empty"><b>Loading ${n} days of prices…</b>Downloading the DSE archive for every stock (${p.done} of ${p.total} weeks). This happens once every few hours.
        <div class="stack" style="height:6px;margin:14px auto 0;max-width:220px"><div style="width:${(p.done / p.total) * 100}%;background:var(--blue)"></div></div></div>`;
      return;
    }
    if (perErr && !per) {
      box.innerHTML = `<div class="empty"><b>Couldn't load past prices</b>${esc(perErr)}<br><br><button class="btn sm" style="width:auto;padding:0 18px;margin:0 auto" data-a="perretry">Try again</button></div>`;
      return;
    }
    list = list.map((q) => periodStat(q, n)).filter(Boolean);
  }
  const q = ui.mQ.trim().toUpperCase();
  if (q) list = list.filter((x) => x.code.includes(q));
  if (m === 'gain') list = list.filter((x) => x.change > 0).sort((a, b) => b.changePct - a.changePct);
  else if (m === 'lose') list = list.filter((x) => x.change < 0).sort((a, b) => a.changePct - b.changePct);
  else if (m === 'value') list.sort((a, b) => (b.value || 0) - (a.value || 0));
  else if (m === 'volume') list.sort((a, b) => (b.volume || 0) - (a.volume || 0));
  else list.sort((a, b) => a.code.localeCompare(b.code));
  const owned = new Set(P().holdings.map((h) => h.code));
  const shown = list.slice(0, 150);
  const span = n ? ` in ${n} days` : '';
  box.innerHTML = (n && perErr ? `<div class="empty" style="padding:12px 16px">Showing older data · couldn't refresh (${esc(perErr)}) · <button data-a="perretry" style="color:var(--blue);font-weight:700">Retry</button></div>` : '')
    + (shown.length ? shown.map((x) => `<button class="it" style="padding:13px 16px" data-a="stock" data-v="${esc(x.code)}">
      <div class="l"><div class="t">${esc(x.code)}${owned.has(x.code) ? '<span class="tag">OWNED</span>' : ''}</div><div class="m n">${m === 'value' ? `৳${fmt(x.value, 2)} mn traded${span}` : `Vol ${fmt(x.volume, 0)}${span}`}</div></div>
      <div class="r"><div class="p n">${fmt(x.ltp)}</div></div><span class="chg n ${cls(x.change)}">${pct(x.changePct)}</span></button>`).join('')
    + (list.length > 150 ? `<div class="empty" style="padding:16px">Showing 150 of ${list.length} — search to narrow down</div>` : '')
    : `<div class="empty">${q ? `No stock matches “${esc(q)}”` : 'Nothing to show'}</div>`);
}

/* =============================== watchlist =============================== */
function vWatch() {
  const n = S.watch.length, na = S.watch.reduce((s, w) => s + (w.above > 0) + (w.below > 0) + (w.pct > 0), 0);
  const head = `<header class="hd"><div><h1>Watchlist</h1><div class="sub">${n} stock${n === 1 ? '' : 's'} · ${na} alert${na === 1 ? '' : 's'} on</div></div><div class="hd-btns">
    <button class="ibtn" data-a="go" data-v="alerts" aria-label="Alerts history">${ic('history', 20, 1.8)}${unread() ? `<span class="badge n">${unread()}</span>` : ''}</button>
    <button class="ibtn primary" data-a="alertform" aria-label="Add stock to watchlist">${ic('plus', 20, 2.3)}</button></div></header>${banner()}`;
  if (!n) return { nav: 'watch', html: head + `<div class="card empty"><b>Nothing on your watchlist</b>Add stocks to follow and set price alerts — for example, tell me when a stock goes above your target or below your stop-loss.<br><br><button class="btn sm" style="width:auto;padding:0 18px;margin:0 auto" data-a="alertform">Add a stock</button></div>` };
  const lastHit = {};
  S.alertLog.forEach((a) => { if (!lastHit[a.code] && Date.now() - a.ts < 864e5 && a.kind !== 'pct') lastHit[a.code] = a; });
  const owned = new Set(P().holdings.map((h) => h.code));
  return { nav: 'watch', html: head + `<div style="display:flex;flex-direction:column;gap:10px;margin:4px 16px 0">${S.watch.map((w) => {
    const q = S.quotes[w.code];
    const hit = lastHit[w.code];
    let sub = '';
    if (hit) sub = `<div class="pill sm warn n" style="margin-top:6px;display:inline-flex;gap:6px;align-items:center">${ic('check', 13, 2.4)}${hit.kind === 'above' ? 'Target' : 'Stop-loss'} ${fmt(hit.target)} hit at ${timeOf(hit.ts)}</div>`;
    else if (q && w.above > q.ltp) sub = `<div class="m n" style="font-size:12.5px;color:var(--muted);margin-top:2px">${w.below > 0 ? '' : 'Alert above ' + fmt(w.above) + ' · '}${fmt(((w.above - q.ltp) / q.ltp) * 100, 1)}% to target</div>`;
    else if (w.below > 0 && !(w.above > 0)) sub = `<div style="font-size:12.5px;color:var(--muted);margin-top:2px" class="n">Alert below ${fmt(w.below)}${q ? ` · ${fmt(((q.ltp - w.below) / q.ltp) * 100, 1)}% above it` : ''}</div>`;
    else if (w.pct > 0) sub = `<div style="font-size:12.5px;color:var(--muted);margin-top:2px" class="n">Alert on a ±${fmt(w.pct, 1)}% day${q ? ` · now ${pct(q.changePct, 1)}` : ''}</div>`;
    else if (!(w.above > 0) && !(w.below > 0)) sub = `<div style="font-size:12.5px;color:var(--blue);margin-top:2px;font-weight:700">+ Add an alert</div>`;
    const range = q && w.above > 0 && w.below > 0 && w.above > w.below ? Math.max(0, Math.min(100, ((q.ltp - w.below) / (w.above - w.below)) * 100)) : null;
    return `<button class="card" style="margin:0;text-align:left;width:100%;${hit ? 'border:1.5px solid #F79009' : ''}" data-a="stock" data-v="${esc(w.code)}">
      <div class="row" style="align-items:flex-start"><div><div style="font-weight:800;font-size:16px;display:flex;gap:6px;align-items:center">${esc(w.code)}${owned.has(w.code) ? '<span class="tag">OWNED</span>' : ''}</div>${sub}</div>
      <div style="text-align:right">${q ? `<div class="n" style="font-weight:800;font-size:16px">${fmt(q.ltp)}</div><div class="n ${cls(q.change)}" style="font-size:12.5px;font-weight:700">${sgn(q.change)} (${pct(q.changePct)})</div>` : '<div class="muted" style="font-size:12.5px">no price</div>'}</div></div>
      ${range != null ? `<div class="track"><div class="fill" style="width:${range}%"></div><div class="knob" style="left:${range}%"></div></div><div class="row n" style="margin-top:8px;font-size:12px;font-weight:700"><span class="down">▼ Stop ${fmt(w.below)}</span><span class="up">Target ${fmt(w.above)} ▲</span></div>` : ''}
      ${w.note ? `<div style="font-size:12.5px;color:var(--muted);margin-top:8px">${esc(w.note)}</div>` : ''}
    </button>`;
  }).join('')}</div>
  <p class="note">Alerts are checked every ${S.settings.refreshSec >= 120 ? Math.round(S.settings.refreshSec / 60) + ' minutes' : 'minute'} while the market is open and the app is running, and each time you open it.</p>` };
}

/* =============================== insights =============================== */
function vInsights() {
  const p = P();
  const head = `<header class="hd" style="display:block"><h1>Insights</h1><div style="margin-top:14px">${seg([['1M', '1M'], ['3M', '3M'], ['year', 'This year'], ['all', 'All time']], ui.iP, 'iperiod')}</div></header>`;
  if (!S.trades.length) return { nav: 'insights', html: head + `<div class="card empty"><b>Nothing to report yet</b>Insights appear once you've recorded some trades.</div>` };
  const t = today();
  const from = ui.iP === '1M' ? new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10) : ui.iP === '3M' ? new Date(Date.now() - 91 * 864e5).toISOString().slice(0, 10) : ui.iP === 'year' ? t.slice(0, 4) + '-01-01' : '0000';
  const ev = p.events.filter((e) => e.date >= from);
  const realized = ev.filter((e) => e.type === 'SELL').reduce((s, e) => s + e.gain, 0);
  const divs = ev.filter((e) => e.type === 'DIV').reduce((s, e) => s + e.gain, 0);
  const snapKeys = Object.keys(S.snapshots).sort();
  const baseKey = [...snapKeys].reverse().find((k) => k < from);
  const firstTrade = S.trades.map((x) => x.date).sort()[0];
  let unrealChange = p.unrealized, note = '';
  if (ui.iP !== 'all' && firstTrade < from) {
    if (baseKey) unrealChange = p.unrealized - (S.snapshots[baseKey].value - S.snapshots[baseKey].invested);
    else note = `Counting from your first saved snapshot isn't possible yet, so unrealized gains are shown in full.`;
  }
  const total = unrealChange + realized + divs;
  const fees = S.trades.filter((x) => x.date >= from).reduce((s, x) => s + (+x.fee || 0), 0);
  const parts = [[unrealChange, 'Unrealized gains', '#1D4ED8'], [realized, 'Realized gains', '#F79009'], [divs, 'Dividends', '#6CA0F5']];
  const absSum = parts.reduce((s, [v]) => s + Math.abs(v), 0) || 1;
  const periodLabel = { '1M': 'last month', '3M': 'last 3 months', year: 'this year', all: 'all time' }[ui.iP];
  const best = [...p.holdings].sort((a, b) => b.unrealPct - a.unrealPct);
  const maxAbs = Math.max(...best.map((h) => Math.abs(h.unrealPct)), 1);
  const months = monthly(p);
  const top1 = p.holdings[0], top2w = (p.holdings[0]?.weight || 0) + (p.holdings[1]?.weight || 0);
  const sells = ev.filter((e) => e.type === 'SELL');
  return { nav: 'insights', html: head + `
    <section class="card" style="margin-top:4px;padding:18px">
      <div class="lbl" style="font-size:13px">Total return · ${periodLabel}</div>
      <div style="display:flex;align-items:baseline;gap:10px;margin-top:2px;flex-wrap:wrap"><span class="n ${cls(total)}" style="font-size:30px;font-weight:800;letter-spacing:-.6px">${sgnTk(total)}</span><span class="n ${cls(total)}" style="font-size:14px;font-weight:750">${p.invested > 0 ? pct((total / p.invested) * 100, 1) + ' on cost' : ''}</span></div>
      <div class="stack" style="height:10px;margin-top:14px">${parts.map(([v, , c]) => `<div style="width:${(Math.abs(v) / absSum) * 100}%;background:${c}"></div>`).join('')}</div>
      <div style="display:flex;flex-direction:column;gap:9px;margin-top:14px;font-size:13.5px">
        ${parts.map(([v, l, c]) => `<div style="display:flex;align-items:center;gap:8px"><span class="sq" style="background:${c}"></span><span style="flex:1">${l}</span><span class="n ${cls(v)}" style="font-weight:700">${sgnTk(v)}</span></div>`).join('')}
        <div style="display:flex;align-items:center;gap:8px;color:var(--muted)"><span class="sq"></span><span style="flex:1">Fees paid (already deducted)</span><span class="n" style="font-weight:600">${tk(fees)}</span></div>
      </div>
      ${note ? `<div style="font-size:12px;color:var(--muted);margin-top:10px">${note}</div>` : ''}
    </section>
    <section class="card">
      <div class="row"><h2>Gain or loss by month</h2><span style="font-size:12px;color:var(--muted)">৳</span></div>
      ${months.length >= 1 ? `<div class="chart"><canvas id="c-mon"></canvas></div><div style="font-size:12.5px;color:var(--muted);margin-top:6px">${months.filter((m) => m.v > 0).length} up month${months.filter((m) => m.v > 0).length === 1 ? '' : 's'}, ${months.filter((m) => m.v < 0).length} down. Includes realized gains and dividends in each month.</div>`
        : `<div style="font-size:13px;color:var(--muted);margin-top:10px">Builds up from daily snapshots — check back after the app has been used across a month end.</div>`}
    </section>
    ${best.length ? `<section class="card"><h2 style="margin-bottom:14px">Best and worst holdings</h2><div style="display:flex;flex-direction:column;gap:14px">${best.map((h) => `<button data-a="stock" data-v="${esc(h.code)}" style="display:grid;grid-template-columns:104px 1fr 60px;align-items:center;gap:10px;text-align:left">
      <span style="font-weight:700;font-size:13.5px;overflow:hidden;text-overflow:ellipsis">${esc(h.code)}</span>
      <span style="height:10px;border-radius:5px;background:var(--line-2);position:relative"><span style="position:absolute;left:0;top:0;bottom:0;width:${Math.max(4, (Math.abs(h.unrealPct) / maxAbs) * 100)}%;border-radius:5px;background:${h.unrealPct >= 0 ? 'var(--up-mid)' : 'var(--down-mid)'}"></span></span>
      <span class="n ${cls(h.unrealPct)}" style="text-align:right;font-weight:750;font-size:13.5px">${pct(h.unrealPct, 1)}</span></button>`).join('')}</div>
      <div style="font-size:12.5px;color:var(--muted);margin-top:12px">Unrealized return on cost, for shares you still hold.</div></section>` : ''}
    <section class="grid2 stats">
      <div class="stat"><div class="lbl">Dividend income</div><div class="v n" style="font-size:20px;font-weight:800">${tk(divs)}</div><div class="n" style="font-size:12.5px;color:var(--muted);margin-top:2px">${p.invested > 0 ? fmt((divs / p.invested) * 100, 2) + '% yield on cost' : ''}</div></div>
      <div class="stat"><div class="lbl">Realized gains</div><div class="v n ${cls(realized)}" style="font-size:20px;font-weight:800">${sgnTk(realized)}</div><div class="n" style="font-size:12.5px;color:var(--muted);margin-top:2px">${sells.length} sale${sells.length === 1 ? '' : 's'}${sells.length ? ' · ' + esc([...new Set(sells.map((s) => s.code))].slice(0, 2).join(', ')) : ''}</div></div>
    </section>
    ${p.holdings.length >= 2 && (top1.weight > 30 || top2w > 50) ? `<section class="warnbox" style="display:flex;gap:12px;border-radius:18px;padding:16px"><span class="ico sm" style="background:#FEF0C7;color:#93370D">${ic('pie', 18, 2)}</span><div><div style="font-weight:750">Concentration</div><div style="margin-top:2px">Your top two holdings make up ${fmt(top2w, 1)}% of the portfolio. ${esc(top1.code)} alone is ${fmt(top1.weight, 1)}%.</div></div></section>` : ''}`,
  after() {
    const el = $('#c-mon');
    if (!el) return;
    charts.push(new Chart(el, {
      type: 'bar',
      data: { labels: months.map((m) => m.label), datasets: [{ label: 'Gain', data: months.map((m) => m.v), backgroundColor: months.map((m) => (m.v >= 0 ? '#12B76A' : '#F04438')), borderRadius: 5, maxBarThickness: 28 }] },
      options: { maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { backgroundColor: '#101828', callbacks: { label: (c) => sgnTk(c.raw) } } },
        scales: { x: { grid: { display: false }, border: { display: false }, ticks: { maxRotation: 0, autoSkip: false, font: { size: 10.5 } } }, y: { position: 'right', border: { display: false }, grid: { color: '#F2F4F7' }, ticks: { maxTicksLimit: 4, callback: (v) => fmt(v / 1000, 1) + 'k' } } } },
    }));
  } };
}

function monthly(p) {
  const keys = Object.keys(S.snapshots).sort();
  if (!keys.length) return [];
  const U = (k) => S.snapshots[k].value - S.snapshots[k].invested;
  const byMonth = {};
  keys.forEach((k) => (byMonth[k.slice(0, 7)] = k)); // last snapshot each month
  const ms = Object.keys(byMonth).sort().slice(-8);
  const out = [];
  let prevU = null;
  const firstKey = keys[0];
  ms.forEach((m, i) => {
    const endU = m === today().slice(0, 7) ? p.unrealized : U(byMonth[m]);
    let startU = prevU;
    if (startU == null) {
      const before = keys.filter((k) => k < m + '-01');
      startU = before.length ? U(before[before.length - 1]) : (S.trades.some((t) => t.date < m + '-01') ? U(firstKey) : 0);
    }
    const flows = p.events.filter((e) => e.date.slice(0, 7) === m).reduce((s, e) => s + e.gain, 0);
    out.push({ label: new Date(m + '-01T00:00:00').toLocaleDateString('en-GB', { month: 'short' }), v: Math.round(endU - startU + flows) });
    prevU = endU;
    void i;
  });
  return out;
}

/* =============================== stock page =============================== */
function vStock({ code }) {
  const q = S.quotes[code];
  const p = P();
  const h = p.holdings.find((x) => x.code === code);
  const pos = p.positions[code];
  const w = S.watch.find((x) => x.code === code);
  const sig = mineSig[code];
  const trades = S.trades.filter((t) => t.code === code).sort((a, b) => (b.date + b.id).localeCompare(a.date + a.id));
  const ind = sig?.ind;
  const breakEven = h ? h.cost / h.qty / (1 - S.settings.commissionPct / 100) : null;
  const sideMeta = { buy: ['Buy signal', 'up'], sell: ['Sell signal', 'down'], watch: ['Watch', 'warn'], none: ['No signal · hold', 'gray'] };
  return { bar: `<div class="bottombar"><div class="inner grid2"><button class="btn ghost" style="min-height:52px" data-a="tradeform" data-code="${esc(code)}" data-type="SELL" ${h ? '' : 'disabled'}>Sell</button><button class="btn" style="min-height:52px" data-a="tradeform" data-code="${esc(code)}" data-type="BUY">${h ? 'Buy more' : 'Buy'}</button></div></div>`,
    cls: 'barred', html: `
    <div class="bar"><button class="back" data-a="back" aria-label="Back">${ic('back', 22, 2)}</button><div style="flex:1"></div>
      <button class="tbtn ${w ? 'soft' : ''}" data-a="watchtoggle" data-v="${esc(code)}">${w ? ic('check', 16, 2.2) + 'Watching' : ic('eye', 16, 2) + 'Watch'}</button>
      <button class="ibtn" style="margin-left:6px" data-a="alertform" data-v="${esc(code)}" aria-label="Price alerts">${ic('bell', 20, 1.8)}</button></div>
    <section style="padding:4px 20px 0">
      <h1 style="margin:0;font-size:22px;font-weight:800;letter-spacing:-.3px">${esc(code)}</h1>
      ${q ? `<div style="display:flex;align-items:baseline;gap:10px;margin-top:12px;flex-wrap:wrap"><span class="n" style="font-size:36px;font-weight:800;letter-spacing:-1px">${fmt(q.ltp)}</span><span class="n ${cls(q.change)}" style="font-size:15px;font-weight:750">${arrow(q.change)}${fmt(Math.abs(q.change))} (${pct(q.changePct)})</span></div>
      <div style="font-size:12.5px;color:var(--muted);margin-top:2px">Today · ${ago(S.quotesAt)}${S.demo ? ' · demo prices' : ' · prices from DSE'}</div>` : `<div class="muted" style="margin-top:8px">No price for this code in today's DSE list.</div>`}
    </section>
    <section class="card" style="padding:14px 14px 12px">
      <div class="chart" style="margin-top:0;height:214px"><canvas id="c-stock"></canvas></div>
      <div style="margin-top:12px">${seg([[30, '1M'], [90, '3M'], [180, '6M'], [365, '1Y'], [1095, '3Y']], ui.sR, 'srange')}</div>
      <div id="s-msg" class="n" style="font-size:12.5px;color:var(--muted);margin-top:10px;min-height:18px">Loading price history…</div>
    </section>
    ${q ? `<section class="card"><h2 style="margin-bottom:12px">Today's trading</h2><div class="grid2" style="gap:14px 16px">
      <div><div class="lbl" style="font-size:12px">Prev. close</div><div class="n" style="font-weight:700;margin-top:2px">${fmt(q.ycp)}</div></div>
      <div><div class="lbl" style="font-size:12px">Day range</div><div class="n" style="font-weight:700;margin-top:2px">${q.low > 0 ? fmt(q.low) + ' – ' + fmt(q.high) : '—'}</div></div>
      <div><div class="lbl" style="font-size:12px">52-week range</div><div class="n" id="s-52" style="font-weight:700;margin-top:2px">${ind ? fmt(ind.low52) + ' – ' + fmt(ind.high52) : '—'}</div></div>
      <div><div class="lbl" style="font-size:12px">Volume</div><div class="n" style="font-weight:700;margin-top:2px">${fmt(q.volume, 0)}</div></div>
      <div><div class="lbl" style="font-size:12px">Value</div><div class="n" style="font-weight:700;margin-top:2px">৳${fmt(q.value, 2)} mn</div></div>
      <div><div class="lbl" style="font-size:12px">Trades</div><div class="n" style="font-weight:700;margin-top:2px">${fmt(q.trade, 0)}</div></div>
    </div></section>` : ''}
    ${h ? `<section class="card"><div class="row"><h2>Your position</h2><span style="font-size:12.5px;color:var(--muted)">${fmt(h.weight, 1)}% of portfolio</span></div>
      <div class="row" style="align-items:flex-end;margin-top:12px"><div><div class="lbl" style="font-size:12px">Market value</div><div class="n" style="font-size:24px;font-weight:800;letter-spacing:-.4px">${tk(h.value)}</div></div><span class="pill ${cls(h.unreal)} n">${sgnTk(h.unreal)} (${pct(h.unrealPct)})</span></div>
      <div class="grid3" style="margin-top:14px">
        <div class="mini"><div class="k">Shares</div><div class="v n">${fmt(h.qty, 0)}</div></div>
        <div class="mini"><div class="k">Avg cost</div><div class="v n">${fmt(h.avg)}</div></div>
        <div class="mini"><div class="k">Today</div><div class="v n ${cls(h.dayChange)}">${sgnTk(h.dayChange)}</div></div>
        <div class="mini"><div class="k">Cost</div><div class="v n">${tk(h.cost)}</div></div>
        <div class="mini"><div class="k">Dividends</div><div class="v n">${tk(pos.dividends)}</div></div>
        <div class="mini"><div class="k">Break-even</div><div class="v n">${fmt(breakEven)}</div></div>
      </div>
      ${pos.realized ? `<div class="n" style="font-size:12.5px;color:var(--muted);margin-top:10px">Realized so far: <b class="${cls(pos.realized)}">${sgnTk(pos.realized)}</b></div>` : ''}</section>`
      : pos && (pos.realized || pos.dividends) ? `<div class="card tight n" style="font-size:13px;color:var(--muted)">Closed position · realized <b class="${cls(pos.realized)}">${sgnTk(pos.realized)}</b> · dividends ${tk(pos.dividends)}</div>` : ''}
    <button class="card" style="display:block;width:calc(100% - 32px);text-align:left" data-a="go" data-v="rules">
      <div class="row"><div style="display:flex;align-items:center;gap:8px"><span style="font-weight:750">Signal</span>${sig ? `<span class="pill sm ${sideMeta[sig.side][1]}">${sideMeta[sig.side][0]}</span>` : '<span class="pill sm gray" id="s-sigpill">Checking…</span>'}</div><span style="font-size:13px;font-weight:700;color:var(--blue)">Rules</span></div>
      <div id="s-sig">${sig ? stockSigBody(sig, !!h) : ''}</div>
    </button>
    <button class="linkcard" style="border-radius:20px" data-a="alertform" data-v="${esc(code)}">
      <span class="ico warn">${ic('bell', 18, 2)}</span>
      <div style="flex:1"><div style="font-weight:750">Price alerts</div><div class="n" style="font-size:12.5px;color:var(--muted)">${w && (w.above || w.below || w.pct) ? [w.above && 'Above ' + fmt(w.above), w.below && 'below ' + fmt(w.below), w.pct && '±' + fmt(w.pct, 1) + '% day'].filter(Boolean).join(' · ') : 'None set'}</div></div>
      <span style="font-size:13.5px;font-weight:700;color:var(--blue)">${w ? 'Edit' : 'Add'}</span>
    </button>
    ${trades.length ? `<section class="card" style="padding:0;overflow:hidden"><div class="row" style="padding:16px 16px 6px"><h2>Your trades in ${esc(code)}</h2></div>${trades.map((t) => tradeRow(t, false)).join('')}</section>` : ''}`,
  after() { stockChart(code); if (!sig) loadStockSig(code); } };
}
function stockSigBody(sig, isHeld) {
  if (sig.insufficient) return `<div style="font-size:12.5px;color:var(--muted);margin-top:10px">Not enough trading history yet for signals.</div>`;
  const i = sig.ind;
  const tp = sig.own.find((o) => o.text.includes('Take-profit'));
  return `<div class="grid3" style="margin-top:12px">
      <div class="mini"><div class="k">RSI (14)</div><div class="v n">${isFinite(i.rsi) ? Math.round(i.rsi) : '—'}</div></div>
      <div class="mini"><div class="k">vs 50-day</div><div class="v n">${pct(i.vs50, 1)}</div></div>
      <div class="mini"><div class="k">From 52w low</div><div class="v n">${pct(i.fromLow, 1)}</div></div></div>
    <div class="n" style="font-size:12.5px;color:var(--muted);margin-top:10px">${sig.buy.met} of ${sig.buy.total} buy rules · ${sig.sell.met} of ${sig.sell.total} sell rules met.${isHeld && tp ? ' ' + esc(tp.text) + '.' : ''}</div>`;
}
async function loadStockSig(code) {
  try {
    mineSig[code] = evaluate(await getHist(code), S.rules, positionOf(code));
    if (cur().name === 'stock' && cur().p.code === code) {
      const s = mineSig[code];
      const meta = { buy: ['Buy signal', 'up'], sell: ['Sell signal', 'down'], watch: ['Watch', 'warn'], none: ['No signal · hold', 'gray'] }[s.side];
      const pill = $('#s-sigpill'); if (pill) { pill.className = `pill sm ${meta[1]}`; pill.textContent = meta[0]; }
      const body = $('#s-sig'); if (body) body.innerHTML = stockSigBody(s, !!held(code));
      const r52 = $('#s-52'); if (r52 && s.ind) r52.textContent = fmt(s.ind.low52) + ' – ' + fmt(s.ind.high52);
    }
  } catch {
    const pill = $('#s-sigpill'); if (pill) pill.textContent = 'Unavailable';
  }
}
const stockHist = {};
async function stockChart(code) {
  const msg = $('#s-msg');
  let rows;
  try {
    if (ui.sR <= 365) rows = (await getHist(code)).filter((r) => r.date >= new Date(Date.now() - ui.sR * 864e5).toISOString().slice(0, 10));
    else {
      const k = code + ':' + ui.sR + today() + S.demo;
      rows = stockHist[k] ||= S.demo ? demoHistory(S.quotes[code], ui.sR) : await fetchHistory(code, ui.sR);
    }
  } catch (e) {
    if (msg) msg.textContent = `Couldn't load history (${e.message}).`;
    return;
  }
  if (cur().name !== 'stock' || cur().p.code !== code || !$('#c-stock')) return;
  if (!rows.length) { msg.textContent = 'No trading history for this range.'; return; }
  const first = rows[0].close, last = rows[rows.length - 1].close, ch = ((last - first) / first) * 100;
  const hi = Math.max(...rows.map((r) => r.close)), lo = Math.min(...rows.map((r) => r.close));
  msg.innerHTML = `<b class="${cls(ch)}">${pct(ch, 1)}</b> over this period · high ${fmt(hi)} · low ${fmt(lo)}`;
  const color = ch >= 0 ? '#12B76A' : '#F04438';
  const avg = held(code)?.avg;
  const ds = [{ type: 'line', label: 'Close', data: rows.map((r) => r.close), yAxisID: 'y', borderColor: color, borderWidth: 2.4, pointRadius: 0, tension: 0.2, fill: true,
    backgroundColor: (c) => { const g = c.chart.ctx.createLinearGradient(0, 0, 0, 214); g.addColorStop(0, color + '33'); g.addColorStop(1, color + '00'); return g; } },
  { type: 'bar', label: 'Volume', data: rows.map((r) => r.volume), yAxisID: 'v', backgroundColor: '#D0D5DD', borderRadius: 2 }];
  if (avg) ds.push({ type: 'line', label: 'Your avg cost', data: rows.map(() => avg), yAxisID: 'y', borderColor: '#F79009', borderDash: [5, 4], borderWidth: 1.6, pointRadius: 0 });
  const o = chartOpts();
  o.scales.v = { display: false, max: Math.max(...rows.map((r) => r.volume || 0)) * 4 };
  killCharts();
  charts.push(new Chart($('#c-stock'), { data: { labels: rows.map((r) => r.date), datasets: ds }, options: o }));
}

/* =============================== trades =============================== */
function tradeRow(t, showCode = true) {
  const meta = { BUY: ['Buy', 'green', 'arrUp'], SELL: ['Sell', 'red', 'arrDown'], DIV: ['Cash dividend', 'purple', null], BONUS: ['Bonus shares', 'blue', 'plus'] }[t.type];
  const total = t.type === 'BUY' ? -(t.qty * t.price + t.fee) : t.type === 'SELL' ? t.qty * t.price - t.fee : t.type === 'DIV' ? t.price - (t.fee || 0) : 0;
  const desc = t.type === 'DIV' ? dShort(t.date) : t.type === 'BONUS' ? `${dShort(t.date)} · ${fmt(t.qty, 0)} free shares` : `${dShort(t.date)} · ${fmt(t.qty, 0)} × ${fmt(t.price)}${t.fee ? ` · fee ${fmt(t.fee, 0)}` : ''}`;
  return `<button class="it" style="padding:13px 16px" data-a="tradeform" data-id="${t.id}">
    <span class="ico sm ${meta[1]}">${meta[2] ? ic(meta[2], 18, 2.2) : '<b style="font-size:15px">৳</b>'}</span>
    <div class="l"><div class="t">${showCode ? `${esc(t.code)} <span style="font-weight:600;color:var(--muted)">· ${meta[0]}</span>` : meta[0]}</div><div class="m n">${desc}${t.note ? ' · ' + esc(t.note) : ''}</div></div>
    <span class="n ${t.type === 'BUY' ? '' : cls(total)}" style="font-weight:750">${t.type === 'BONUS' ? '' : sgnTk(total)}</span></button>`;
}
function vTrades() {
  const f = ui.tF, q = ui.tQ.trim().toUpperCase();
  const list = [...S.trades].filter((t) => (f === 'all' || (f === 'buy' && t.type === 'BUY') || (f === 'sell' && t.type === 'SELL') || (f === 'div' && (t.type === 'DIV' || t.type === 'BONUS'))) && (!q || t.code.includes(q)))
    .sort((a, b) => (b.date + b.id).localeCompare(a.date + a.id));
  const bought = S.trades.filter((t) => t.type === 'BUY').reduce((s, t) => s + t.qty * t.price, 0);
  const sold = S.trades.filter((t) => t.type === 'SELL').reduce((s, t) => s + t.qty * t.price, 0);
  const fees = S.trades.reduce((s, t) => s + (+t.fee || 0), 0);
  const groups = {};
  list.forEach((t) => (groups[t.date.slice(0, 7)] ||= []).push(t));
  return { html: bar('Trades', { right: `<button class="tbtn" data-a="csv">${ic('download', 16, 2)}Export CSV</button>` }) + `
    <section class="card" style="margin-top:4px;padding:12px 4px;border-radius:16px"><div class="grid3" style="gap:0">
      <div style="text-align:center"><div class="lbl" style="font-size:12px">Bought</div><div class="n" style="font-weight:750;margin-top:2px">${tk(bought)}</div></div>
      <div style="text-align:center;border-left:1px solid var(--line-2);border-right:1px solid var(--line-2)"><div class="lbl" style="font-size:12px">Sold</div><div class="n" style="font-weight:750;margin-top:2px">${tk(sold)}</div></div>
      <div style="text-align:center"><div class="lbl" style="font-size:12px">Fees</div><div class="n" style="font-weight:750;margin-top:2px">${tk(fees)}</div></div></div></section>
    <div class="search" style="margin-top:12px">${ic('search', 18, 2, 'style="color:#667085"')}<input id="tq" placeholder="Filter by trading code" value="${esc(ui.tQ)}" autocapitalize="characters" aria-label="Filter by trading code"></div>
    <div class="chips" style="margin-top:10px">${[['all', 'All'], ['buy', 'Buys'], ['sell', 'Sells'], ['div', 'Dividends']].map(([v, l]) => chip(v, l, f === v, 'tfilter')).join('')}</div>
    <div id="tlist">${tradeGroups(groups)}</div>
    <button class="fab" data-a="newtrade" aria-label="Add trade">${ic('plus', 24, 2.4)}</button>`,
  after() { $('#tq').addEventListener('input', (e) => { ui.tQ = e.target.value; const qq = ui.tQ.trim().toUpperCase(); const g = {}; S.trades.filter((t) => !qq || t.code.includes(qq)).filter((t) => f === 'all' || (f === 'buy' && t.type === 'BUY') || (f === 'sell' && t.type === 'SELL') || (f === 'div' && (t.type === 'DIV' || t.type === 'BONUS'))).sort((a, b) => (b.date + b.id).localeCompare(a.date + a.id)).forEach((t) => (g[t.date.slice(0, 7)] ||= []).push(t)); $('#tlist').innerHTML = tradeGroups(g); }); } };
}
function tradeGroups(groups) {
  const ks = Object.keys(groups);
  if (!ks.length) return `<div class="card empty"><b>${S.trades.length ? 'No trades match' : 'No trades yet'}</b>${S.trades.length ? '' : 'Every buy, sell, dividend and bonus you record shows up here.'}</div>`;
  return ks.map((k) => `<h2 class="section-t">${monthName(k)}</h2><div class="list">${groups[k].map(tradeRow).join('')}</div>`).join('');
}

/* =============================== trade form =============================== */
function openTrade({ id, code = '', type = 'BUY' } = {}) {
  const t = id && S.trades.find((x) => x.id === id);
  tf = t ? { ...t, feeTouched: true } : { id: null, type, code, qty: '', price: type === 'DIV' ? '' : S.quotes[code]?.ltp ?? '', date: today(), fee: '', note: '', feeTouched: false };
  go('trade');
}
function vTrade() {
  const t = tf;
  const q = S.quotes[t.code];
  const h = held(t.code);
  const lblPrice = t.type === 'DIV' ? 'Total dividend received (৳)' : 'Price per share (৳)';
  return { cls: 'white barred', bar: `<div class="bottombar"><div class="inner"><button class="btn ${t.type === 'SELL' ? '' : t.type === 'BUY' ? 'green' : ''}" style="${t.type === 'SELL' ? 'background:var(--down)' : ''}" data-a="savetrade">${t.id ? 'Save changes' : { BUY: 'Save buy', SELL: 'Save sell', DIV: 'Save dividend', BONUS: 'Save bonus shares' }[t.type]}</button>
    ${t.id ? `<button class="btn text red" data-a="deltrade">Delete this trade</button>` : ''}</div></div>`,
  html: bar(t.id ? 'Edit trade' : 'New trade', { close: true, center: true }) + `<div style="padding:8px 20px 0">
    <div class="seg" role="group" aria-label="Trade type">${[['BUY', 'Buy'], ['SELL', 'Sell'], ['DIV', 'Dividend'], ['BONUS', 'Bonus']].map(([v, l]) => `<button class="${t.type === v ? 'on' : ''}" style="padding:10px 0;font-size:13.5px;${t.type === v ? `color:${v === 'BUY' ? 'var(--up)' : v === 'SELL' ? 'var(--down)' : 'var(--ink)'}` : ''}" data-a="ttype" data-v="${v}" aria-pressed="${t.type === v}">${l}</button>`).join('')}</div>
    <div class="field"><label for="f-code">Stock</label><input id="f-code" class="inp" list="codes" autocapitalize="characters" autocomplete="off" placeholder="Trading code, e.g. GP" value="${esc(t.code)}">${codeList()}
      <div id="f-codeinfo" class="n" style="font-size:12.5px;color:var(--muted);margin-top:6px">${t.code ? (h ? `You hold ${fmt(h.qty, 0)} · avg ${fmt(h.avg)}` : 'You don\'t hold this yet') + (q ? ` · LTP ${fmt(q.ltp)}` : '') : ''}</div></div>
    ${t.type !== 'DIV' ? `<div class="grid2" style="gap:12px">
      <div class="field"><label for="f-qty">${t.type === 'BONUS' ? 'Bonus shares received' : 'Quantity'}</label><input id="f-qty" class="inp big n" inputmode="numeric" value="${esc(t.qty)}"></div>
      ${t.type !== 'BONUS' ? `<div class="field"><label for="f-price">${lblPrice}</label><input id="f-price" class="inp big n" inputmode="decimal" value="${esc(t.price)}"></div>` : '<div></div>'}</div>
      ${t.type !== 'BONUS' ? `<div style="display:flex;gap:8px;margin-top:10px">${[50, 100, 500].map((n) => `<button class="chip sm n" data-a="addqty" data-v="${n}">+${n}</button>`).join('')}<div style="flex:1"></div>${t.type === 'SELL' && h ? `<button class="chip sm" data-a="sellall">All ${fmt(h.qty, 0)}</button>` : ''}<button class="chip sm" style="border:0;background:var(--blue-soft);color:var(--blue)" data-a="useltp">Use LTP</button></div>` : ''}`
      : `<div class="field"><label for="f-price">${lblPrice}</label><input id="f-price" class="inp big n" inputmode="decimal" value="${esc(t.price)}"></div>`}
    <div class="grid2" style="gap:12px">
      <div class="field"><label for="f-date">Date</label><input id="f-date" class="inp" type="date" value="${esc(t.date)}" style="font-size:15px"></div>
      ${t.type !== 'BONUS' ? `<div class="field"><label for="f-fee">${t.type === 'DIV' ? 'Tax deducted (৳)' : 'Commission (৳)'}</label><div class="inwrap"><input id="f-fee" class="inp n" inputmode="decimal" value="${esc(t.fee)}" style="font-size:15px">${!t.feeTouched && t.type !== 'DIV' ? `<span class="tagr">${fmt(S.settings.commissionPct, 2)}% auto</span>` : ''}</div></div>` : '<div></div>'}
    </div>
    <div class="field"><label for="f-note">Note (optional)</label><input id="f-note" class="inp" style="font-size:15px;font-weight:500" placeholder="e.g. broker, reason" value="${esc(t.note)}"></div>
    <section id="f-sum" style="margin-top:20px;background:var(--soft);border-radius:18px;padding:16px">${tradeSummary()}</section>
  </div>`,
  after() {
    const read = () => {
      tf.code = $('#f-code').value.trim().toUpperCase();
      if ($('#f-qty')) tf.qty = $('#f-qty').value;
      if ($('#f-price')) tf.price = $('#f-price').value;
      tf.date = $('#f-date').value || today();
      tf.note = $('#f-note').value;
      if ($('#f-fee')) {
        if (document.activeElement?.id === 'f-fee') tf.feeTouched = true;
        if (!tf.feeTouched && (tf.type === 'BUY' || tf.type === 'SELL')) {
          const g = (+tf.qty || 0) * (+tf.price || 0);
          tf.fee = g ? (g * S.settings.commissionPct / 100).toFixed(2) : '';
          $('#f-fee').value = tf.fee;
        } else tf.fee = $('#f-fee').value;
      }
      $('#f-sum').innerHTML = tradeSummary();
    };
    $('#app').addEventListener('input', read);
    $('#f-code').addEventListener('change', () => {
      read();
      const q = S.quotes[tf.code];
      if (q && !+tf.price && tf.type !== 'DIV' && tf.type !== 'BONUS') { $('#f-price').value = tf.price = q.ltp; read(); }
      const h = held(tf.code);
      $('#f-codeinfo').textContent = tf.code ? (h ? `You hold ${fmt(h.qty, 0)} · avg ${fmt(h.avg)}` : "You don't hold this yet") + (q ? ` · LTP ${fmt(q.ltp)}` : (Object.keys(S.quotes).length ? ' · not in today\'s DSE list' : '')) : '';
    });
    read.call();
  } };
}
function tradeSummary() {
  const t = tf, qty = +t.qty || 0, pr = +t.price || 0, fee = +t.fee || 0;
  const pos = computePortfolio(S.trades.filter((x) => x.id !== t.id && x.date <= (t.date || today())), S.quotes).positions[t.code];
  const line = (a, b, c = '') => `<div class="row" style="font-size:14px;margin-top:8px"><span style="color:var(--muted)">${a}</span><span class="n ${c}" style="font-weight:650">${b}</span></div>`;
  const tot = (a, b) => `<div style="height:1px;background:#EAECF0;margin:12px 0"></div><div class="row" style="align-items:baseline"><span style="font-weight:750">${a}</span><span class="n" style="font-size:20px;font-weight:800">${b}</span></div>`;
  const box = (h) => `<div class="n" style="margin-top:10px;font-size:12.5px;color:var(--ink-2);background:#fff;border:1px solid #EAECF0;border-radius:10px;padding:9px 11px">${h}</div>`;
  if (t.type === 'BUY') {
    if (!qty || !pr) return '<span class="muted" style="font-size:13.5px">Enter quantity and price to see the total.</span>';
    const total = qty * pr + fee;
    const nq = (pos?.qty || 0) + qty, navg = ((pos?.cost || 0) + total) / nq;
    return line(`${fmt(qty, 0)} × ${fmt(pr)}`, '৳' + fmt(qty * pr)) + line('Commission', '৳' + fmt(fee)) + tot('Total you pay', '৳' + fmt(total)) + box(`After this: <b>${fmt(nq, 0)} shares</b> at avg <b>${fmt(navg)}</b>${pos?.qty ? ` (now ${fmt(pos.cost / pos.qty)})` : ''}`);
  }
  if (t.type === 'SELL') {
    if (!qty || !pr) return '<span class="muted" style="font-size:13.5px">Enter quantity and price to see proceeds and profit.</span>';
    const have = pos?.qty || 0;
    if (qty > have) return `<span class="down" style="font-size:13.5px;font-weight:600">You held only ${fmt(have, 0)} ${esc(t.code)} shares on ${dLong(t.date)}.</span>`;
    const proceeds = qty * pr - fee, gain = proceeds - (pos.cost / pos.qty) * qty;
    return line(`${fmt(qty, 0)} × ${fmt(pr)}`, '৳' + fmt(qty * pr)) + line('Commission', '−৳' + fmt(fee)) + tot('You receive', '৳' + fmt(proceeds)) + box(`Realized profit on this sale: <b class="${cls(gain)}">${sgnTk(gain, 2)}</b>${have - qty > 0 ? ` · ${fmt(have - qty, 0)} shares left` : ' · position closed'}`);
  }
  if (t.type === 'DIV') {
    if (!pr) return '<span class="muted" style="font-size:13.5px">Enter the total cash dividend you received.</span>';
    return line('Dividend', '৳' + fmt(pr)) + line('Tax deducted', '−৳' + fmt(fee)) + tot('Net received', '৳' + fmt(pr - fee)) + (pos?.qty ? box(`That's ৳${fmt((pr - fee) / pos.qty)} per share on ${fmt(pos.qty, 0)} shares`) : '');
  }
  if (!qty) return '<span class="muted" style="font-size:13.5px">Enter how many bonus shares you received.</span>';
  if (!pos?.qty) return `<span class="down" style="font-size:13.5px">You don't hold ${esc(t.code) || 'this stock'} on that date.</span>`;
  return line('Shares', `${fmt(pos.qty, 0)} → ${fmt(pos.qty + qty, 0)}`) + box(`Average cost falls from <b>${fmt(pos.cost / pos.qty)}</b> to <b>${fmt(pos.cost / (pos.qty + qty))}</b>`);
}
function saveTrade() {
  const t = tf, code = t.code.trim().toUpperCase();
  const qty = t.type === 'DIV' ? 0 : Math.round(+t.qty), price = t.type === 'BONUS' ? 0 : +t.price, fee = t.type === 'BONUS' ? 0 : +t.fee || 0;
  if (!code) return toast('Enter a trading code');
  if (t.type !== 'DIV' && !(qty > 0)) return toast('Enter a quantity');
  if (t.type !== 'BONUS' && !(price > 0)) return toast(t.type === 'DIV' ? 'Enter the dividend amount' : 'Enter a price');
  if (t.type === 'SELL' || t.type === 'BONUS') {
    const pos = computePortfolio(S.trades.filter((x) => x.id !== t.id && x.date <= t.date), S.quotes).positions[code];
    if (t.type === 'SELL' && (!pos || pos.qty < qty)) return toast(`You held only ${fmt(pos?.qty || 0, 0)} ${code} on that date`);
    if (t.type === 'BONUS' && !pos?.qty) return toast(`You don't hold ${code} on that date`);
  }
  const rec = { id: t.id || uid(), date: t.date || today(), code, type: t.type, qty, price, fee, note: (t.note || '').trim() };
  if (t.id) S.trades = S.trades.map((x) => (x.id === t.id ? rec : x)); else S.trades.push(rec);
  if (code in mineSig) delete mineSig[code];
  afterQuotes();
  toast(t.id ? 'Trade updated' : 'Trade saved');
  stack.pop();
  if (cur().name !== 'stock') { cur().y = 0; }
  render();
}

/* =============================== alert form =============================== */
function openAlert(code = '') {
  const w = S.watch.find((x) => x.code === code);
  af = { code, orig: code, above: w?.above || '', below: w?.below || '', pct: w?.pct || 5, onA: !!w?.above, onB: !!w?.below, onP: !!w?.pct, note: w?.note || '', exists: !!w };
  if (!w && code) { const q = S.quotes[code]; if (q) { af.above = (q.ltp * 1.1).toFixed(1); af.below = (q.ltp * 0.9).toFixed(1); af.onA = af.onB = true; } }
  go('alert');
}
function alertLadder() {
  const a = af, q = S.quotes[a.code], h = held(a.code);
  const rel = (v) => (q && +v > 0 ? pct(((v - q.ltp) / q.ltp) * 100, 1) : '');
  const rows = [];
  if (a.onA && +a.above) rows.push([+a.above, `<span class="dot2" style="background:var(--up)"><span style="color:#fff">${ic('arrUp', 12, 3)}</span></span><span style="flex:1;font-size:13.5px;font-weight:700">Target</span><span class="n" style="font-weight:800">${fmt(+a.above)}</span><span class="n up" style="width:58px;text-align:right;font-size:12.5px;font-weight:700">${rel(a.above)}</span>`]);
  if (q) rows.push([q.ltp, `<span class="dot2" style="background:var(--blue);border:4px solid #D1E0FF"></span><span style="flex:1;font-size:13.5px;font-weight:700;color:var(--blue)">Now</span><span class="n" style="font-weight:800">${fmt(q.ltp)}</span><span style="width:58px"></span>`]);
  if (h) rows.push([h.avg, `<span class="dot2" style="background:#fff;border:2px dashed #F79009"></span><span style="flex:1;font-size:13.5px;font-weight:600;color:var(--muted)">Your avg cost</span><span class="n" style="font-weight:700;color:var(--muted)">${fmt(h.avg)}</span><span class="n muted" style="width:58px;text-align:right;font-size:12.5px;font-weight:700">${rel(h.avg)}</span>`]);
  if (a.onB && +a.below) rows.push([+a.below, `<span class="dot2" style="background:var(--down)"><span style="color:#fff">${ic('arrDown', 12, 3)}</span></span><span style="flex:1;font-size:13.5px;font-weight:700">Stop-loss</span><span class="n" style="font-weight:800">${fmt(+a.below)}</span><span class="n down" style="width:58px;text-align:right;font-size:12.5px;font-weight:700">${rel(a.below)}</span>`]);
  rows.sort((x, y) => y[0] - x[0]);
  return rows.length > 1 ? `<section class="ladder" aria-label="Price ladder">${rows.map(([, r]) => `<div class="lr">${r}</div>`).join('')}</section>` : '';
}
function vAlert() {
  const a = af, q = S.quotes[a.code];
  return { cls: 'white barred', bar: `<div class="bottombar"><div class="inner"><button class="btn" data-a="savealert">${a.exists ? 'Save alerts' : 'Add to watchlist'}</button>${a.exists ? `<button class="btn text red" data-a="unwatch">Remove from watchlist</button>` : ''}</div></div>`,
  html: bar(a.exists ? 'Price alerts' : 'Watch a stock', { close: true, center: true }) + `<div style="padding:6px 20px 0">
    ${a.orig ? `<div class="row"><div><div style="font-weight:800;font-size:17px">${esc(a.code)}</div><div style="font-size:12.5px;color:var(--muted)">Current price</div></div><div class="n" style="font-size:24px;font-weight:800">${q ? fmt(q.ltp) : '—'}</div></div>`
      : `<div class="field" style="margin-top:4px"><label for="a-code">Trading code</label><input id="a-code" class="inp" list="codes" autocapitalize="characters" autocomplete="off" placeholder="e.g. BATBC" value="${esc(a.code)}">${codeList()}</div>`}
    <div id="ladder">${alertLadder()}</div>
    <div class="card" style="margin:18px 0 0;border-radius:18px;padding:14px 16px">
      <div class="row"><label for="a-above" style="font-size:14px;font-weight:750">Alert when price goes above</label>${sw(a.onA, 'atog', 'Above alert', 'data-v="onA"')}</div>
      <input id="a-above" class="inp n" style="margin-top:10px" inputmode="decimal" value="${esc(a.above)}" style="${a.onA ? '' : 'opacity:.55'}" aria-label="Alert above price">
      ${q ? `<div style="display:flex;gap:8px;margin-top:10px">${[5, 10, 20].map((n) => `<button class="chip sm n" data-a="aquick" data-v="${n}">+${n}%</button>`).join('')}</div>` : ''}
    </div>
    <div class="card" style="margin:10px 0 0;border-radius:18px;padding:14px 16px">
      <div class="row"><label for="a-below" style="font-size:14px;font-weight:750">Alert when price falls below</label>${sw(a.onB, 'atog', 'Below alert', 'data-v="onB"')}</div>
      <input id="a-below" class="inp n" style="margin-top:10px" inputmode="decimal" value="${esc(a.below)}" style="${a.onB ? '' : 'opacity:.55'}" aria-label="Alert below price">
      ${q ? `<div style="display:flex;gap:8px;margin-top:10px">${[5, 8, 10].map((n) => `<button class="chip sm n" data-a="bquick" data-v="${n}">−${n}%</button>`).join('')}</div>` : ''}
    </div>
    <div class="card" style="margin:10px 0 0;border-radius:18px;padding:14px 16px">
      <div class="row"><div><div style="font-size:14px;font-weight:750">Big daily move</div><div style="font-size:12.5px;color:var(--muted)">Alert if it moves ± this much in a day</div></div>${sw(a.onP, 'atog', 'Daily move alert', 'data-v="onP"')}</div>
      <div class="inwrap" style="margin-top:10px"><input id="a-pct" class="inp n" inputmode="decimal" value="${esc(a.pct)}" style="${a.onP ? '' : 'opacity:.55'}" aria-label="Daily move percent"><span class="tagr">%</span></div>
    </div>
    <div class="field"><label for="a-note">Note (optional)</label><input id="a-note" class="inp" style="font-size:15px;font-weight:500" placeholder="Why you're watching it" value="${esc(a.note)}"></div>
  </div>`,
  after() {
    const read = (e) => {
      if ($('#a-code')) af.code = $('#a-code').value.trim().toUpperCase();
      af.above = $('#a-above').value; af.below = $('#a-below').value; af.pct = $('#a-pct').value; af.note = $('#a-note').value;
      // typing a value switches that alert on
      const map = { 'a-above': 'onA', 'a-below': 'onB', 'a-pct': 'onP' };
      const k = e && e.target && map[e.target.id];
      if (k && e.type === 'input' && !af[k] && e.target.value) {
        af[k] = true; e.target.style.opacity = '';
        const sw = document.querySelector(`[data-a="atog"][data-v="${k}"]`); if (sw) { sw.classList.add('on'); sw.setAttribute('aria-checked', 'true'); }
      }
    };
    $('#app').addEventListener('input', read);
    $('#app').addEventListener('input', () => { const l = $('#ladder'); if (l) l.innerHTML = alertLadder(); });
    $('#a-code')?.addEventListener('change', () => { read(); const q = S.quotes[af.code]; if (q) { af.above = (q.ltp * 1.1).toFixed(1); af.below = (q.ltp * 0.9).toFixed(1); } render(); });
  } };
}
async function saveAlert() {
  const a = af, code = (a.code || '').trim().toUpperCase();
  if (!code) return toast('Enter a trading code');
  const rec = { code, above: a.onA ? +a.above || 0 : 0, below: a.onB ? +a.below || 0 : 0, pct: a.onP ? +a.pct || 0 : 0, note: (a.note || '').trim() };
  if (rec.above && rec.below && rec.below >= rec.above) return toast('Stop-loss must be below the target');
  const old = S.watch.find((w) => w.code === code);
  S.watch = S.watch.filter((w) => w.code !== code && w.code !== a.orig);
  S.watch.push({ ...old, ...rec, firedAbove: false, firedBelow: false });
  save();
  if ((rec.above || rec.below || rec.pct) && S.settings.notify) await askNotify();
  afterQuotes();
  toast(old ? 'Alerts saved' : `${code} added to your watchlist`);
  stack.pop();
  render();
}

/* =============================== alerts history =============================== */
function vAlerts() {
  const n = S.watch.length, na = S.watch.reduce((s, w) => s + (w.above > 0) + (w.below > 0) + (w.pct > 0), 0);
  const t0 = new Date(); t0.setHours(0, 0, 0, 0);
  const todayL = S.alertLog.filter((a) => a.ts >= t0), earlier = S.alertLog.filter((a) => a.ts < t0);
  const row = (a) => {
    const [icn, c, title, sub] = a.kind === 'above' ? ['arrUp', 'green', `${a.code} reached your target`, `Traded at ${fmt(a.ltp)}, above ${fmt(a.target)}`]
      : a.kind === 'below' ? ['arrDown', 'red', `${a.code} hit your stop-loss`, `Traded at ${fmt(a.ltp)}, below ${fmt(a.target)}`]
      : [a.changePct >= 0 ? 'trend' : 'trendDown', a.changePct >= 0 ? 'warn' : 'red', `${a.code} moved ${pct(a.changePct, 1)} today`, `Price ${fmt(a.ltp)} · your daily-move alert is ±${fmt(a.target, 1)}%`];
    return `<button class="it" style="align-items:flex-start;${a.read ? '' : 'background:#F5F8FF'}" data-a="stock" data-v="${esc(a.code)}"><span class="ico sm ${c}">${ic(icn, 18, 2.2)}</span>
      <div class="l"><div class="row"><span style="font-weight:750">${esc(title)}</span><span class="n" style="font-size:12px;color:var(--muted)">${a.ts >= t0 ? timeOf(a.ts) : dShort(new Date(a.ts).toISOString().slice(0, 10))}</span></div><div class="n" style="font-size:13px;color:var(--ink-3);margin-top:2px">${sub}</div></div>
      ${a.read ? '' : '<span style="width:8px;height:8px;border-radius:50%;background:var(--blue);margin-top:6px;flex:none" aria-label="Unread"></span>'}</button>`;
  };
  return { html: bar('Alerts', { right: unread() ? '<button class="tbtn link" data-a="readall">Mark all read</button>' : '' }) + `
    <button class="linkcard" style="background:var(--blue);border-color:var(--blue);color:#fff;border-radius:18px;margin-top:4px" data-a="tab" data-v="watch">
      <span class="ico" style="background:rgba(255,255,255,.16)">${ic('bell', 20, 2)}</span>
      <div style="flex:1"><div style="font-weight:750">${na} alert${na === 1 ? '' : 's'} active on ${n} stock${n === 1 ? '' : 's'}</div><div style="font-size:12.5px;opacity:.9">Checked every refresh in market hours</div></div><span style="font-size:13.5px;font-weight:700">Manage</span></button>
    ${S.alertLog.length ? `${todayL.length ? `<h2 class="section-t">Today</h2><div class="list">${todayL.map(row).join('')}</div>` : ''}${earlier.length ? `<h2 class="section-t">Earlier</h2><div class="list">${earlier.map(row).join('')}</div>` : ''}`
      : `<div class="card empty"><b>No alerts yet</b>When a stock hits one of your targets or stop-losses, it's logged here.</div>`}
    <p class="note">The last 90 days of alerts are kept on this phone.</p>` };
}

/* =============================== signals =============================== */
function vSignals() {
  const p = P();
  const heldCodes = p.holdings.map((h) => h.code);
  const watchCodes = S.watch.map((w) => w.code).filter((c) => !heldCodes.includes(c));
  const scan = S.scan && S.scan.day === today() && S.scan.demo === S.demo ? S.scan : S.scan;
  const scanR = scan ? Object.entries(scan.results) : [];
  const nb = scanR.filter(([, r]) => r.side === 'buy').length, ns = scanR.filter(([, r]) => r.side === 'sell').length;
  const loaded = heldCodes.concat(watchCodes).every((c) => mineSig[c]);
  const f = ui.sF;
  const card = (code, s, isHeld) => {
    if (!s) return `<div class="card tight" style="font-size:13px;color:var(--muted)">${esc(code)} — loading history…</div>`;
    if (s.insufficient) return `<div class="card tight" style="font-size:13px;color:var(--muted)">${esc(code)} — not enough trading history for signals.</div>`;
    const meta = { buy: ['Buy signal', 'up', '#079455'], sell: ['Sell signal', 'down', '#D92D20'], watch: ['Watch', 'warn', '#F79009'], none: ['No signal', 'gray', '#98A2B3'] }[s.side];
    const useSell = s.side === 'sell' ? true : s.side === 'buy' ? false : s.sell.met >= s.buy.met;
    const set = useSell ? s.sell : s.buy;
    const color = useSell ? 'var(--down)' : 'var(--up)';
    const q = S.quotes[code], h = isHeld ? held(code) : null;
    const items = [...(useSell && isHeld ? s.own.filter((o) => o.ok) : []), ...set.items.filter((x) => x.ok), ...set.items.filter((x) => !x.ok).slice(0, 1), ...(useSell && isHeld ? s.own.filter((o) => !o.ok).slice(0, 1) : [])];
    return `<section class="card">
      <div class="row" style="align-items:flex-start"><div><div style="display:flex;align-items:center;gap:8px"><span style="font-weight:800;font-size:16px">${esc(code)}</span><span class="pill sm ${meta[1]}">${meta[0]}</span></div>
        <div class="n" style="font-size:12.5px;color:var(--muted);margin-top:3px">${q ? fmt(q.ltp) : ''}${h ? ` · you're ${h.unrealPct >= 0 ? 'up' : 'down'} ${pct(h.unrealPct, 1)} (avg ${fmt(h.avg)})` : q ? ` · ${pct(q.changePct)} today` : ''}</div></div>
        <div style="text-align:right">${score(set.met, set.total, meta[2])}<div style="font-size:11.5px;color:var(--muted);margin-top:4px">${set.met} of ${set.total} ${useSell ? 'sell' : 'buy'} rules</div></div></div>
      <ul class="reasons">${items.map((r) => reasonLi(r, color)).join('')}</ul>
      ${s.side === 'buy' || s.side === 'sell' ? `<div class="grid2" style="margin-top:14px;gap:8px"><button class="btn ghost sm" data-a="stock" data-v="${esc(code)}">View chart</button>
        <button class="btn sm ${s.side === 'sell' ? 'soft-red' : 'soft-green'}" data-a="tradeform" data-code="${esc(code)}" data-type="${s.side === 'sell' ? 'SELL' : 'BUY'}" ${s.side === 'sell' && !isHeld ? 'disabled' : ''}>Record a ${s.side}</button></div>` : ''}
    </section>`;
  };
  const quiet = (codes) => codes.filter((c) => mineSig[c] && (mineSig[c].side === 'none'));
  let body = '';
  if (f === 'mine') {
    const hs = heldCodes.filter((c) => !mineSig[c] || mineSig[c].side !== 'none');
    const ws = watchCodes.filter((c) => !mineSig[c] || mineSig[c].side !== 'none');
    const qh = quiet(heldCodes), qw = quiet(watchCodes);
    body = (heldCodes.length ? `<h2 class="section-t">Your holdings</h2>${hs.map((c) => card(c, mineSig[c], true)).join('')}${qh.length ? `<div class="card tight n" style="border-style:dashed;font-size:13px;color:var(--muted)">${esc(qh.join(', '))}: no rules met — holding steady.</div>` : ''}` : '')
      + (watchCodes.length ? `<h2 class="section-t">From your watchlist</h2>${ws.map((c) => card(c, mineSig[c], false)).join('')}${qw.length ? `<div class="card tight n" style="border-style:dashed;font-size:13px;color:var(--muted)">${esc(qw.join(', '))}: no rules met.</div>` : ''}` : '')
      || `<div class="card empty"><b>No stocks to check yet</b>Add holdings or watchlist stocks, or scan the whole market below.</div>`;
  } else {
    const want = f === 'all' ? null : f;
    const list = scanR.filter(([, r]) => !want || r.side === want).sort((a, b) => (b[1].side === 'sell' ? b[1].sm : b[1].bm) - (a[1].side === 'sell' ? a[1].sm : a[1].bm));
    body = !scan ? `<div class="card empty"><b>Market not scanned yet</b>Scan all ${allCodes().length || 'listed'} stocks against your rules. It downloads a year of history for each stock, so it takes a few minutes.</div>`
      : list.length ? `<div class="list" style="margin-top:12px">${list.map(([c, r]) => `<button class="it" data-a="stock" data-v="${esc(c)}"><div class="l"><div class="t">${esc(c)} <span class="pill sm ${r.side === 'buy' ? 'up' : 'down'}">${r.side === 'buy' ? 'Buy' : 'Sell'}</span></div><div class="m">${esc(r.why.join(' · '))}</div></div><div class="r n" style="font-size:12px;color:var(--muted)">${r.side === 'buy' ? r.bm + '/' + r.bt : r.sm + '/' + r.st}</div></button>`).join('')}</div>`
      : `<div class="card empty"><b>No ${want || ''} signals</b>Nothing in the last scan met your rules.</div>`;
  }
  return { html: `<div class="bar"><button class="back" data-a="back" aria-label="Back">${ic('back', 22, 2)}</button><div style="flex:1"><h1 style="margin:0;font-size:20px;font-weight:800">Signals</h1><div style="font-size:12px;color:var(--muted)">${S.demo ? 'Demo data' : ago(S.quotesAt).replace('updated', 'From prices')}</div></div>
      <button class="tbtn" data-a="go" data-v="rules">${ic('sliders', 16, 2)}Rules</button></div>
    <div class="info">${ic('info', 18, 2, 'style="flex:none;margin-top:1px;color:#475467"')}<span>Signals come from price, volume and your own targets, using the rules you set. They don't look at earnings, news or company health — treat them as a prompt to check, not advice.</span></div>
    <div class="grid3" style="margin:14px 16px 0">
      <div class="stat" style="padding:10px 12px;border-radius:14px"><div class="lbl" style="font-size:11.5px">Buy signals</div><div class="n up" style="font-size:20px;font-weight:800">${scan ? nb : '—'}</div></div>
      <div class="stat" style="padding:10px 12px;border-radius:14px"><div class="lbl" style="font-size:11.5px">Sell signals</div><div class="n down" style="font-size:20px;font-weight:800">${scan ? ns : '—'}</div></div>
      <div class="stat" style="padding:10px 12px;border-radius:14px"><div class="lbl" style="font-size:11.5px">Scanned</div><div class="n" style="font-size:20px;font-weight:800">${scan ? scan.total : 0}</div></div>
    </div>
    ${scanning ? `<div class="card tight"><div id="scantxt" style="font-size:13px;font-weight:700">Scanning ${scanning.done} of ${scanning.total}…</div><div class="progress"><i id="scanbar" style="width:${(scanning.done / scanning.total) * 100}%"></i></div></div>`
      : `<button class="btn ghost sm" style="margin:12px 16px 0;width:calc(100% - 32px)" data-a="scan">${ic('refresh', 16, 2)}${scan ? `Rescan market · last ${scan.day === today() ? 'today ' + timeOf(scan.at) : dShort(scan.day)}` : 'Scan the whole market'}</button>`}
    <div class="chips">${[['mine', 'Mine'], ['buy', 'Buy'], ['sell', 'Sell'], ['all', 'All stocks']].map(([v, l]) => chip(v, l, f === v, 'sfilter')).join('')}</div>
    ${f === 'mine' && !loaded && Object.keys(S.quotes).length ? '<div class="note" style="margin-top:10px">Loading price history for your stocks…</div>' : ''}
    ${body}`,
  after() { if (f === 'mine' && !loaded) computeMine(); } };
}

function vRules() {
  const R = S.rules;
  const r = (side, key, title, desc) => {
    const x = R[side][key];
    return `<div class="setrow"><div class="l"><span class="t">${title}</span><span class="d n">${desc}</span></div>
      ${'v' in DEFAULT_RULES[side][key] ? `<input class="num-in n" inputmode="decimal" value="${x.v}" data-rule="${side}.${key}" aria-label="${esc(title)} value">` : ''}
      ${sw(x.on, 'rtog', title, `data-v="${side}.${key}"`)}</div>`;
  };
  return { cls: 'barred', bar: `<div class="bottombar"><div class="inner"><button class="btn" data-a="saverules">Save and recheck</button></div></div>`,
    html: bar('Signal rules', { right: '<button class="tbtn link" data-a="resetrules">Reset</button>' }) + `
    <p style="margin:4px 20px 0;font-size:13.5px;line-height:1.5;color:var(--ink-3)">A stock gets a signal when at least <b>${R.minRules} rules</b> on the same side are met. Turn rules off or change the numbers to match how you invest.</p>
    <div class="card tight row"><span style="font-weight:700">Rules needed for a signal</span><div style="display:flex;gap:6px">${[1, 2, 3].map((n) => `<button class="chip pick sm ${R.minRules === n ? 'on' : ''}" data-a="minrules" data-v="${n}">${n}</button>`).join('')}</div></div>
    <h2 class="section-t green">Buy rules</h2>
    <div class="list">${r('buy', 'rsiLow', 'Oversold (RSI)', '14-day RSI below this')}${r('buy', 'near52Low', 'Near 52-week low', 'Within this % of the year\'s low')}${r('buy', 'golden', 'Golden cross', '50-day average crosses above the 200-day')}${r('buy', 'volSurge', 'Volume surge', 'Volume this many × its 20-day average')}</div>
    <h2 class="section-t red">Sell rules</h2>
    <div class="list">${r('sell', 'rsiHigh', 'Overbought (RSI)', '14-day RSI above this')}${r('sell', 'stretched', 'Stretched above average', 'More than this % above its 50-day average')}${r('sell', 'trendBreak', 'Trend break', 'Closes below its 50-day average this many days')}${r('sell', 'death', 'Death cross', '50-day average crosses below the 200-day')}</div>
    <h2 class="section-t">Your own targets (holdings only)</h2>
    <div class="card" style="margin-top:0"><div class="grid2" style="gap:12px">
      <div><label class="flabel" for="r-tp">Take profit at (+%)</label><input id="r-tp" class="inp n" inputmode="decimal" value="${R.takeProfit}"></div>
      <div><label class="flabel" for="r-sl">Stop-loss at (−%)</label><input id="r-sl" class="inp n" inputmode="decimal" value="${R.stopLoss}"></div></div>
      <p style="margin:10px 0 0;font-size:12.5px;color:var(--muted);line-height:1.45">Measured from your average cost. Either one gives a sell signal on its own.</p></div>
    <div class="card tight row" style="margin-bottom:8px"><div><div style="font-weight:700">Notify me about new signals</div><div style="font-size:12.5px;color:var(--muted)">Once a day after the market closes</div></div>${sw(R.notify, 'rnotify', 'Signal notifications')}</div>` };
}
function readRules() {
  document.querySelectorAll('[data-rule]').forEach((el) => { const [s, k] = el.dataset.rule.split('.'); const v = parseFloat(el.value); if (isFinite(v) && v >= 0) S.rules[s][k].v = v; });
  const tp = parseFloat($('#r-tp')?.value), sl = parseFloat($('#r-sl')?.value);
  if (tp > 0) S.rules.takeProfit = tp;
  if (sl > 0) S.rules.stopLoss = sl;
}

/* =============================== settings =============================== */
function vSettings() {
  const s = S.settings;
  return { html: bar('Settings') + `
    <h2 class="section-t" style="margin-top:12px">Trading</h2>
    <div class="list">
      <div class="setrow"><div class="l"><span class="t">Broker commission</span><span class="d">Auto-filled on every buy and sell</span></div><input id="s-comm" class="num-in n" inputmode="decimal" value="${s.commissionPct}" aria-label="Commission percent"><span class="muted" style="font-weight:700">%</span></div>
      <div class="setrow"><div class="l"><span class="t">Cost method</span><span class="d">How profit on sells is worked out</span></div><span style="font-weight:650;color:var(--ink-3)">Average cost</span></div>
    </div>
    <h2 class="section-t">Live data</h2>
    <div class="list">
      <div class="setrow"><div class="l"><span class="t">Refresh every (seconds)</span><span class="d">Only during market hours, Sun–Thu 10:00–2:30</span></div><input id="s-ref" class="num-in n" inputmode="numeric" value="${s.refreshSec}" aria-label="Refresh seconds"></div>
      <div class="setrow"><div class="l"><span class="t">Data source</span><span class="d">${ago(S.quotesAt)}</span></div><span style="font-weight:650;color:var(--ink-3)">dsebd.org</span></div>
    </div>
    <h2 class="section-t">Notifications</h2>
    <div class="list">
      <div class="setrow"><div class="l"><span class="t">Price alerts</span><span class="d">Targets, stop-losses and big moves</span></div>${sw(s.notify, 'stog', 'Price alert notifications', 'data-v="notify"')}</div>
      <div class="setrow"><div class="l"><span class="t">Market close summary</span><span class="d">Your day's P/L after 2:30 pm</span></div>${sw(s.closeSummary, 'stog', 'Market close summary', 'data-v="closeSummary"')}</div>
      <div class="setrow"><div class="l"><span class="t">New signals</span><span class="d">Once a day after the close</span></div>${sw(S.rules.notify, 'rnotify', 'Signal notifications')}</div>
      <button class="setrow" style="color:var(--blue);font-weight:700" data-a="testnotify">Send a test alert</button>
    </div>
    <h2 class="section-t">Your data</h2>
    <div class="list">
      <div style="padding:14px 16px;background:var(--soft);font-size:12.5px;color:var(--ink-3);line-height:1.45">Everything is stored on this phone only. Back up now and then, and keep the copy in Drive or email it to yourself.</div>
      <button class="setrow" data-a="backup">${ic('upload', 20)}<div class="l"><span class="t">Back up data</span><span class="d">${S.lastBackup ? 'Last backup ' + dShort(S.lastBackup) : 'Copies a backup to your clipboard'}</span></div></button>
      <button class="setrow" data-a="restoretoggle">${ic('download', 20)}<div class="l"><span class="t">Restore from backup</span></div></button>
      ${ui.restoreOpen ? `<div style="padding:0 16px 16px"><textarea id="restore" class="inp" rows="4" placeholder="Paste your backup text here"></textarea><button class="btn sm" style="margin-top:10px" data-a="restore">Restore</button></div>` : ''}
      <button class="setrow" data-a="csv">${ic('table', 20)}<div class="l"><span class="t">Export trades as CSV</span></div></button>
      <button class="setrow" style="color:var(--down)" data-a="wipe">${ic('trash', 20)}<div class="l"><span class="t">Erase all data</span></div></button>
    </div>
    <div style="margin:24px 24px 0;text-align:center;font-size:12.5px;color:var(--muted);line-height:1.55"><div style="font-weight:750;color:var(--ink-2)">DSE Desk 1.2</div>Prices from the Dhaka Stock Exchange website, a few minutes delayed. Signals are mechanical rules, not investment advice. ${isNative ? '' : '<br>Web version.'}</div>`,
  after() {
    $('#s-comm').addEventListener('change', (e) => { const v = parseFloat(e.target.value); if (v >= 0) { S.settings.commissionPct = v; save(); toast('Commission saved'); } });
    $('#s-ref').addEventListener('change', (e) => { S.settings.refreshSec = Math.max(30, parseInt(e.target.value) || 60); e.target.value = S.settings.refreshSec; save(); schedule(); toast('Refresh interval saved'); });
  } };
}

/* =============================== render =============================== */
const VIEWS = { welcome: vWelcome, setup: vSetup, first: vFirst, portfolio: vPortfolio, market: vMarket, watch: vWatch, insights: vInsights, stock: vStock, trade: vTrade, alert: vAlert, trades: vTrades, alerts: vAlerts, signals: vSignals, rules: vRules, settings: vSettings };
function render() {
  killCharts();
  // fresh #app node each render so per-view listeners don't pile up
  const old = document.getElementById('app');
  const fresh = old.cloneNode(false);
  const c = cur();
  const v = VIEWS[c.name](c.p);
  if (v.raw) fresh.innerHTML = v.html;
  else fresh.innerHTML = `<div class="screen ${v.nav ? 'tabbed' : ''} ${v.cls || ''}">${v.html}</div>${v.nav ? nav(v.nav) : ''}${v.bar || ''}`;
  old.replaceWith(fresh);
  v.after?.();
}

/* =============================== events =============================== */
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-a]');
  if (!el || el.disabled) return;
  const a = el.dataset.a, v = el.dataset.v;
  switch (a) {
    case 'tab': tab(v); break;
    case 'go': go(v); break;
    case 'back': back(); break;
    case 'refresh': refresh(); break;
    case 'demo': loadDemo(); break;
    case 'stock': if (cur().name === 'alerts') { S.alertLog.forEach((x) => { if (x.code === v) x.read = true; }); save(); } go('stock', { code: v }); break;
    case 'newtrade': openTrade(); break;
    case 'tradeform': openTrade({ id: el.dataset.id, code: el.dataset.code, type: el.dataset.type }); break;
    case 'ttype': tf.type = v; tf.feeTouched = !!tf.id && tf.type === v; if (v === 'DIV') tf.price = ''; else if (!+tf.price && S.quotes[tf.code]) tf.price = S.quotes[tf.code].ltp; if (v !== 'BUY' && v !== 'SELL') tf.fee = ''; render(); break;
    case 'addqty': { const i = $('#f-qty'); i.value = (+i.value || 0) + +v; i.dispatchEvent(new Event('input', { bubbles: true })); break; }
    case 'sellall': { const i = $('#f-qty'); i.value = held(tf.code)?.qty || ''; i.dispatchEvent(new Event('input', { bubbles: true })); break; }
    case 'useltp': { const q = S.quotes[($('#f-code').value || '').trim().toUpperCase()]; if (!q) return toast('No live price for this code'); const i = $('#f-price'); i.value = q.ltp; i.dispatchEvent(new Event('input', { bubbles: true })); break; }
    case 'savetrade': saveTrade(); break;
    case 'deltrade': if (confirm('Delete this trade? Your profit figures will be recalculated.')) { S.trades = S.trades.filter((t) => t.id !== tf.id); afterQuotes(); stack.pop(); render(); toast('Trade deleted'); } break;
    case 'alertform': openAlert(v || ''); break;
    case 'atog': af[v] = !af[v]; render(); break;
    case 'aquick': { const q = S.quotes[af.code]; if (q) { af.onA = true; af.above = (q.ltp * (1 + v / 100)).toFixed(1); render(); } break; }
    case 'bquick': { const q = S.quotes[af.code]; if (q) { af.onB = true; af.below = (q.ltp * (1 - v / 100)).toFixed(1); render(); } break; }
    case 'savealert': saveAlert(); break;
    case 'unwatch': S.watch = S.watch.filter((w) => w.code !== af.orig); save(); stack.pop(); render(); toast('Removed from watchlist'); break;
    case 'watchtoggle': {
      const w = S.watch.find((x) => x.code === v);
      if (w) { if (w.above || w.below || w.pct) { if (!confirm(`Stop watching ${v}? Its alerts will be removed.`)) break; } S.watch = S.watch.filter((x) => x.code !== v); toast('Removed from watchlist'); }
      else { S.watch.push({ code: v, above: 0, below: 0, pct: 0, note: '' }); toast(`${v} added to your watchlist`); }
      save(); render(); break;
    }
    case 'mmode': ui.mMode = v; render(); break;
    case 'mper': ui.mPer = v === 'd' ? 'd' : +v; render(); break;
    case 'perretry': perErr = ''; fillMarket(); break;
    case 'tfilter': ui.tF = v; render(); break;
    case 'iperiod': ui.iP = v; render(); break;
    case 'vrange': ui.vR = v; render(); break;
    case 'srange': ui.sR = +v; document.querySelectorAll('[data-a="srange"]').forEach((b) => b.classList.toggle('on', b === el)); stockChart(cur().p.code); break;
    case 'sfilter': ui.sF = v; render(); break;
    case 'scan': scanMarket(); break;
    case 'readall': S.alertLog.forEach((x) => (x.read = true)); save(); render(); break;
    case 'rtog': { readRules(); const [s, k] = v.split('.'); S.rules[s][k].on = !S.rules[s][k].on; render(); break; }
    case 'minrules': readRules(); S.rules.minRules = +v; render(); break;
    case 'rnotify': if (cur().name === 'rules') readRules(); S.rules.notify = !S.rules.notify; save(); render(); break;
    case 'resetrules': if (confirm('Reset all signal rules to the defaults?')) { S.rules = mergeRules(null); save(); render(); } break;
    case 'saverules': readRules(); save(); mineSig = {}; mineDay = null; S.scan = null; save(); stack.pop(); render(); computeMine(true); toast('Rules saved — rechecking your stocks'); break;
    case 'stog': S.settings[v] = !S.settings[v]; if (S.settings[v] && (v === 'notify' || v === 'closeSummary') && !(await askNotify())) toast('Notifications are blocked — allow them in Android settings'); save(); render(); break;
    case 'testnotify': await askNotify(); await notify('DSE Desk alert', 'This is a test — your alerts will look like this.'); toast('Test alert sent'); break;
    case 'backup': {
      const data = JSON.stringify({ app: 'dse-desk', v: 2, at: new Date().toISOString(), trades: S.trades, watch: S.watch, settings: S.settings, rules: S.rules, snapshots: S.snapshots, alertLog: S.alertLog });
      if (await copy(data)) { S.lastBackup = today(); save(); render(); toast(`Backup copied (${S.trades.length} trades) — paste it somewhere safe`, 4000); }
      break;
    }
    case 'csv': {
      const rows = [['date', 'code', 'type', 'qty', 'price', 'fee', 'note'], ...[...S.trades].sort((x, y) => x.date.localeCompare(y.date)).map((t) => [t.date, t.code, t.type, t.qty, t.price, t.fee, `"${(t.note || '').replace(/"/g, '""')}"`])];
      if (await copy(rows.map((r) => r.join(',')).join('\n'))) toast('Trades copied as CSV — paste into Sheets or Excel', 3500);
      break;
    }
    case 'restoretoggle': ui.restoreOpen = !ui.restoreOpen; render(); break;
    case 'restore': {
      try {
        const d = JSON.parse($('#restore').value);
        if (d.app !== 'dse-desk' || !Array.isArray(d.trades)) throw new Error();
        if (!confirm(`Replace the data on this phone with the backup from ${d.at?.slice(0, 10) || 'an unknown date'} (${d.trades.length} trades)?`)) break;
        const base = defaults();
        setState({ ...base, onboarded: true, trades: d.trades, watch: d.watch || [], settings: { ...base.settings, ...d.settings }, rules: mergeRules(d.rules), snapshots: d.snapshots || {}, alertLog: d.alertLog || [], quotes: S.quotes, quotesAt: S.quotesAt, index: S.index, demo: S.demo });
        save(); mineSig = {}; mineDay = null; ui.restoreOpen = false; toast('Backup restored'); tab('portfolio'); computeMine(true);
      } catch { toast("That doesn't look like a DSE Desk backup"); }
      break;
    }
    case 'wipe':
      if (confirm('Erase all trades, watchlist, alerts and settings on this phone? This cannot be undone.')) { localStorage.removeItem(KEY); histClear(); setState(load()); mineSig = {}; stack = [{ name: 'welcome', p: {} }]; render(); toast('All data erased'); }
      break;
    // onboarding
    case 'ob': stack = [{ name: v, p: {} }]; render(); window.scrollTo(0, 0); break;
    case 'ob-comm': S.settings.commissionPct = +v; save(); render(); break;
    case 'ob-notify': { const ok = await askNotify(); el.innerHTML = ok ? `<span class="up">${ic('check', 16, 2.4)}</span> Notifications allowed` : 'Not allowed — you can turn them on later'; break; }
    case 'ob-pick': { $('#ob-code').value = v; if (!$('#ob-avg').value && S.quotes[v]) $('#ob-avg').value = S.quotes[v].ltp; $('#ob-code').dispatchEvent(new Event('input')); break; }
    case 'ob-add': {
      ob.code = $('#ob-code').value.trim().toUpperCase(); ob.qty = $('#ob-qty').value; ob.avg = $('#ob-avg').value;
      if (!ob.code || !(+ob.qty > 0) || !(+ob.avg > 0)) return toast('Fill in the code, shares and average price');
      S.trades.push({ id: uid(), date: today(), code: ob.code, type: 'BUY', qty: Math.round(+ob.qty), price: +ob.avg, fee: 0, note: 'Opening position' });
      save();
      toast(`${ob.code} added`);
      ob = { code: '', qty: '', avg: '' };
      if (v === 'more') render(); else finishOnboarding();
      break;
    }
    case 'ob-done': finishOnboarding(); break;
    case 'ob-restore': S.onboarded = true; save(); ui.restoreOpen = true; stack = [{ name: 'portfolio', p: {} }, { name: 'settings', p: {} }]; render(); break;
  }
});
function finishOnboarding() { S.onboarded = true; afterQuotes(); tab('portfolio'); }

async function copy(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    ui.restoreOpen = true; render();
    const ta = $('#restore'); if (ta) { ta.value = text; ta.select(); document.execCommand('copy'); toast('Copied — the text is also in the box below'); }
    return false;
  }
}

/* =============================== lifecycle =============================== */
let timer = null;
function schedule() {
  clearInterval(timer);
  timer = setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    const m = marketStatus();
    if (m.open && !S.demo) refresh({ silent: true });
    else if (TABS.includes(cur().name)) { const sub = document.querySelector('.hd .sub span:last-child'); if (sub) sub.textContent = sub.textContent.replace(/updated.*$/, ago(S.quotesAt)); }
  }, Math.max(30, S.settings.refreshSec) * 1000);
}
if (isNative) {
  App.addListener('backButton', back);
  App.addListener('appStateChange', ({ isActive }) => { if (isActive) refresh({ silent: true }); });
}
render();
schedule();
refresh({ silent: true });
