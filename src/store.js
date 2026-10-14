import { mergeRules } from './signals.js';

export const KEY = 'dsedesk.v1';
const HKEY = 'dsedesk.hist';

export const defaults = () => ({
  onboarded: false,
  trades: [],
  watch: [],
  settings: { commissionPct: 0.4, refreshSec: 60, notify: true, closeSummary: false },
  rules: mergeRules(null),
  quotes: {},
  quotesAt: null,
  demo: false,
  index: null,
  snapshots: {},
  alertLog: [],
  lastBackup: null,
  scan: null, // { day, results: { CODE: {side,bm,sm,bt,st,ltp,chg} } }
  sent: {}, // notification de-dupe: { closeSummary: day, signals: day }
});

export let S = load();
export function setState(next) { S = next; }

export function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY));
    if (raw) {
      const d = defaults();
      const s = { ...d, ...raw, settings: { ...d.settings, ...raw.settings }, rules: mergeRules(raw.rules) };
      // existing users skip onboarding
      if (raw.onboarded == null) s.onboarded = (raw.trades || []).length > 0 || (raw.watch || []).length > 0;
      return s;
    }
  } catch {}
  return defaults();
}
export function save() {
  try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { console.warn('save failed', e); }
}

/* ---------- price history cache (per stock, refreshed daily) ---------- */
let H = (() => { try { return JSON.parse(localStorage.getItem(HKEY)) || {}; } catch { return {}; } })();
export function histGet(code) { return H[code]; }
export function histSet(code, entry) {
  H[code] = entry;
  const keys = Object.keys(H);
  if (keys.length > 60) {
    keys.sort((a, b) => (H[a].used || 0) - (H[b].used || 0));
    keys.slice(0, keys.length - 60).forEach((k) => delete H[k]);
  }
  try { localStorage.setItem(HKEY, JSON.stringify(H)); } catch { H = { [code]: entry }; try { localStorage.setItem(HKEY, JSON.stringify(H)); } catch {} }
}
export function histClear() { H = {}; try { localStorage.removeItem(HKEY); } catch {} }

/* ---------- formatting ---------- */
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const NF = {};
const nf = (d) => (NF[d] ||= new Intl.NumberFormat('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d }));
export const fmt = (n, d = 2) => (isFinite(n) ? nf(d).format(n) : '—');
export const tk = (n, d = 0) => (isFinite(n) ? (n < 0 ? '−৳' : '৳') + nf(d).format(Math.abs(n)) : '—');
export const sgn = (n, d = 2) => (isFinite(n) ? (n > 0 ? '+' : n < 0 ? '−' : '') + nf(d).format(Math.abs(n)) : '—');
export const sgnTk = (n, d = 0) => (isFinite(n) ? (n > 0.005 ? '+৳' : n < -0.005 ? '−৳' : '৳') + nf(d).format(Math.abs(n)) : '—');
export const pct = (n, d = 2) => (isFinite(n) ? sgn(n, d) + '%' : '—');
export const cls = (n) => (n > 0.00001 ? 'up' : n < -0.00001 ? 'down' : 'flat');
export const arrow = (n) => (n > 0.00001 ? '▲ ' : n < -0.00001 ? '▼ ' : '');
export const today = () => new Date(Date.now() + (new Date().getTimezoneOffset() + 360) * 60000).toISOString().slice(0, 10);
export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
export const dShort = (d) => new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
export const dLong = (d) => new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
export const monthName = (ym) => new Date(ym + '-01T00:00:00').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
export const timeOf = (ts) => new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
export function ago(ts) {
  if (!ts) return 'not updated yet';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'updated just now';
  if (s < 3600) return `updated ${Math.round(s / 60)} min ago`;
  const d = new Date(ts);
  const sameDay = new Date().toDateString() === d.toDateString();
  return 'updated ' + (sameDay ? timeOf(ts) : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ' ' + timeOf(ts));
}
export const initials = (code) => code.replace(/[^A-Z]/g, '').slice(0, 2) || code.slice(0, 2);
const PAL = [['#EEF4FF', '#1D4ED8'], ['#FFFAEB', '#B54708'], ['#EFF8FF', '#175CD3'], ['#FEF6EE', '#93370D'], ['#F4F3FF', '#5925DC'], ['#ECFDF3', '#067647'], ['#FDF2FA', '#C11574']];
export const monoColor = (code) => PAL[[...code].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 0) % PAL.length];
