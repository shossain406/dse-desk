// In-app updates (free, no third-party service).
//
// Every GitHub build publishes four files to the repo's "latest" release:
//   version.json  – what the newest build is (web version, APK build number, file checksums)
//   app.js, styles.css – the app's screens and logic (the same files the APK ships with)
//   DSE-Desk.apk  – the full Android app
//
// Two kinds of update:
//   1. Quick update: most changes only touch app.js / styles.css. The app downloads them, checks their
//      checksums, keeps them on the phone and restarts with them (see the loader in www/index.html).
//      No reinstall, your data stays.
//   2. Full update: when a change needs a new APK (new permission, plugin, icon), version.json says so
//      (minNative) and the app offers to download the APK; Android then asks you to tap Install.
//
// If a quick update ever fails to start, the loader in index.html throws it away and starts the
// version that came with the APK instead.
import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';

/* global __APP_VERSION__, __UPDATE_BASE__ */
export const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0';
const BASE = typeof __UPDATE_BASE__ === 'string' ? __UPDATE_BASE__ : '';
const native = Capacitor.isNativePlatform();

const DB = 'dsedesk-ota', STORE = 'kv';
const DISMISS_KEY = 'dsedesk.upd.dismissed';
const TRY_KEY = 'dsedesk.ota.trying';

/** Live state the UI reads. kind: 'web' (quick update), 'apk' (full update) or null. */
export const upd = {
  supported: native && !!BASE,
  running: APP_VERSION,
  fromUpdate: typeof window !== 'undefined' && !!window.__OTA_VERSION__,
  native: null, // { version, build } of the installed APK
  remote: null,
  kind: null,
  checking: false,
  applying: false,
  progress: '',
  checkedAt: null,
  error: '',
};

/** Compare "1.4.2" style versions: >0 if a is newer */
export function cmpVer(a, b) {
  const pa = String(a || '0').split('.').map((n) => parseInt(n) || 0);
  const pb = String(b || '0').split('.').map((n) => parseInt(n) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/** Called once the app has drawn its first screen: tells the loader this version starts fine. */
export function markBootOk() {
  try { localStorage.removeItem(TRY_KEY); } catch {}
}

async function nativeInfo() {
  if (upd.native) return upd.native;
  try {
    const i = await App.getInfo();
    upd.native = { version: i.version, build: parseInt(i.build) || 0 };
  } catch {
    upd.native = { version: '?', build: 0 };
  }
  return upd.native;
}

async function getWithTimeout(url, ms, as = 'text') {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return as === 'json' ? await r.json() : await r.text();
  } finally {
    clearTimeout(t);
  }
}

/**
 * Ask GitHub whether a newer build exists. Sets upd.kind and upd.remote.
 * Quiet unless `manual` (then errors are shown in Settings).
 */
export async function checkForUpdate({ manual = false } = {}) {
  if (!upd.supported || upd.checking || upd.applying) return upd;
  upd.checking = true;
  upd.error = '';
  try {
    const nat = await nativeInfo();
    const remote = await getWithTimeout(`${BASE}version.json?t=${Date.now()}`, 15000, 'json');
    if (!remote || !remote.version) throw new Error('bad version file');
    upd.remote = remote;
    upd.checkedAt = Date.now();
    const newerWeb = cmpVer(remote.version, APP_VERSION) > 0;
    const canQuick = newerWeb && (remote.minNative || 0) <= nat.build && remote.files?.['app.js'];
    const newerApk = (remote.nativeBuild || 0) > nat.build;
    // A quick update is offered first; a new APK only when the newest screens need one (or nothing else is new).
    upd.kind = canQuick ? 'web' : newerApk ? 'apk' : null;
  } catch (e) {
    if (manual) upd.error = e.name === 'AbortError' ? 'GitHub did not answer in time' : 'Could not check for updates (' + (e.message || 'offline') + ')';
  } finally {
    upd.checking = false;
  }
  return upd;
}

/** Hide the banner for this remote version until the next one (it stays available in Settings). */
export function dismissUpdate() {
  try { localStorage.setItem(DISMISS_KEY, upd.remote?.version || ''); } catch {}
}
export function bannerWanted() {
  if (!upd.kind || !upd.remote) return false;
  try { return localStorage.getItem(DISMISS_KEY) !== upd.remote.version; } catch { return true; }
}

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbPut(key, val) {
  const db = await idb();
  await new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(val, key);
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
  db.close();
}

/** Quick update: download, verify, store, restart. Calls onStep(text) for progress. */
export async function applyWebUpdate(onStep = () => {}) {
  const r = upd.remote;
  if (!r || upd.kind !== 'web' || upd.applying) return;
  upd.applying = true;
  upd.error = '';
  try {
    const files = {};
    for (const name of ['app.js', 'styles.css']) {
      const meta = r.files?.[name];
      if (!meta) throw new Error(`${name} missing from the update`);
      onStep(`Downloading ${name === 'app.js' ? 'app' : 'design'}…`);
      const text = await getWithTimeout(`${BASE}${name}?v=${encodeURIComponent(r.version)}`, 60000);
      if ((await sha256(text)) !== meta.sha256) throw new Error(`${name} did not download correctly`);
      files[name] = text;
    }
    onStep('Installing…');
    await idbPut('bundle', { version: r.version, minNative: r.minNative || 0, js: files['app.js'], css: files['styles.css'], at: Date.now() });
    try { localStorage.removeItem(DISMISS_KEY); localStorage.removeItem('dsedesk.ota.bad'); } catch {}
    onStep('Restarting…');
    setTimeout(() => location.reload(), 300);
  } catch (e) {
    upd.applying = false;
    upd.error = 'Update failed: ' + (e.message || e) + '. Your current version keeps working; try again later.';
    throw e;
  }
}

/** Full update: open the APK download in the phone's browser; Android then offers Install. */
export function openApkDownload() {
  const r = upd.remote;
  const url = `${BASE}${r?.apk || 'DSE-Desk.apk'}`;
  // Capacitor opens links outside the app in the system browser, which downloads the APK.
  location.href = url;
}

/** Throw away a downloaded quick update and go back to the version that came with the APK. */
export async function resetToBuiltIn() {
  try {
    const db = await idb();
    await new Promise((res) => { const tx = db.transaction(STORE, 'readwrite'); tx.objectStore(STORE).delete('bundle'); tx.oncomplete = res; tx.onerror = res; });
    db.close();
  } catch {}
  location.reload();
}
