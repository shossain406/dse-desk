// Builds the web app (src/ -> www/app.js) and writes www/version.json for in-app updates.
//
// version.json tells installed apps what the newest build is:
//   version     – web version from package.json ("1.4.0"). Bump it for every release.
//   nativeBuild – versionCode of the APK this build produces (android/app/build.gradle).
//   minNative   – the oldest APK build that can run this app.js (package.json "dseDesk.minNative").
//                 Raise it to the new versionCode when a change needs a new APK (new plugin,
//                 permission, icon or file in www/ other than app.js and styles.css).
//   files       – SHA-256 checksums so a damaged download is never installed.
import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const cfg = pkg.dseDesk || {};
const gradle = readFileSync('android/app/build.gradle', 'utf8');
const nativeBuild = parseInt((gradle.match(/versionCode\s+(\d+)/) || [])[1]) || 0;
const nativeVersion = (gradle.match(/versionName\s+"([^"]+)"/) || [])[1] || '';
const updateBase = cfg.updateBase || '';

await build({
  entryPoints: ['src/app.js'],
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['es2020', 'chrome80'],
  outfile: 'www/app.js',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __UPDATE_BASE__: JSON.stringify(updateBase),
  },
  logLevel: 'warning',
});

const sum = (f) => {
  const text = readFileSync(f, 'utf8');
  // checksum of the text as the app reads it (UTF-8), matching crypto.subtle in src/update.js
  return { sha256: createHash('sha256').update(text, 'utf8').digest('hex'), size: Buffer.byteLength(text) };
};

const info = {
  app: 'dse-desk',
  version: pkg.version,
  nativeBuild,
  nativeVersion,
  minNative: cfg.minNative || 0,
  apk: 'DSE-Desk.apk',
  notes: cfg.notes || '',
  builtAt: new Date().toISOString(),
  files: { 'app.js': sum('www/app.js'), 'styles.css': sum('www/styles.css') },
};
writeFileSync('www/version.json', JSON.stringify(info, null, 2) + '\n');
console.log(`Built DSE Desk ${info.version} (APK build ${nativeBuild}, quick updates need APK build ${info.minNative}+)`);
