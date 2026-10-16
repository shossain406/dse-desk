# DSE Desk 1.2 — personal DSE investment manager (website + Android)

Live Dhaka Stock Exchange prices, portfolio P/L, watchlist alerts, rule-based buy/sell signals and reports. Everything is stored on your phone.

## Put it online as a website (live prices, free)

The same app runs as a website. Its small server function (`api/dse.js`) fetches DSE prices for the browser, which browsers can't do directly. Vercel hosts both for free.

Do this in the Chrome profile where you're signed in to GitHub as **shossain406**, after the files are pushed to `shossain406/dse-desk` (see below):

1. Go to **vercel.com/signup** and choose **Continue with GitHub**. This makes a free Hobby account tied to shossain406. If you already have one there, just log in.
2. Click **Add New → Project**, then **Import** next to `dse-desk`. If it isn't listed, click **Adjust GitHub App Permissions** and allow the `dse-desk` repo.
3. Leave every setting as it is (`vercel.json` already sets them) and click **Deploy**. It takes about a minute.
4. Open the address Vercel gives you, like `dse-desk-xxxx.vercel.app`, in Chrome on your phone. Tap **⋮ → Add to Home screen → Install**. It opens full-screen like an app.

Every push to GitHub updates the website automatically. Your trades are stored in that phone's browser, so use **Settings → Back up data** now and then.

Website vs. APK: both use the same live prices and the same screens. The website needs nothing installed, but it only sends alerts while it's open. The APK can also notify you when you open it later.

## Get the APK (pushing to shossain406/dse-desk)

Your repo `shossain406/dse-desk` already exists and is empty. Use **GitHub Desktop** signed in as **shossain406** (File → Options → Accounts).

1. **File → Clone repository → shossain406/dse-desk**, then pick a folder, e.g. `Documents\GitHub\dse-desk`. It clones as an empty folder.
2. Unzip `DSE-Desk-v1.1-project.zip`. Open the `dse-desk` folder inside it and copy **everything** into the cloned folder, including the `.github` folder and the `.gitignore` / `.gitattributes` files.
3. In GitHub Desktop you'll see about 100 changed files. Type a summary like `DSE Desk 1.1`, click **Commit to main**, then **Push origin**.
4. On github.com open the repo → **Actions**. "Build DSE Desk APK" starts by itself and takes 6–10 minutes. If GitHub asks you to enable Actions, click the green button, then **Build DSE Desk APK → Run workflow**.
5. When it shows a green tick, open **Releases → DSE Desk (latest build)** on your phone and download **DSE-Desk.apk**. If you can't find it, check the **Artifacts** section at the bottom of the Actions run page.
6. Open the APK. Allow "install from this source" once, then **Install**. If Play Protect warns about an unknown app, tap **More details → Install anyway**.

**Updating later:** replace the files, commit and push again, and a new APK appears in the same release. It installs over the old one and keeps your data, because every build is signed with the same key (`android/app/dsedesk.keystore`). Don't delete that file.

If the build fails, open the red step on the Actions page, take a screenshot and send it to me.

## What's inside

- **First run:** welcome, broker commission and notification setup, and adding your first holding with its average price.
- **Portfolio:** total value, today's change, value-vs-cost chart (1W–All, from daily snapshots), invested, unrealized/realized P/L, dividends, total return, a signals summary, allocation, DSEX, holdings.
- **Market:** all listed DSE stocks, refreshed every minute while the market is open. Advance/decline, turnover, search, gainers/losers/top value/volume for today or the last 5, 15 or 18 trading days.
- **Watchlist:** target, stop-loss and big-daily-move alerts, a price-range bar, and a log of every alert that fired.
- **Stock page:** price chart (1M–3Y) with volume and your average cost, today's trading, 52-week range, your position with break-even, the signal for this stock, alerts, and your trades in it.
- **Add trade:** buy, sell, cash dividend, bonus shares. Commission is auto-filled, and you see the total and your new average cost before saving.
- **Signals:** rule-based buy/sell signals for your holdings and watchlist, plus an optional whole-market scan. Rules you can change: RSI, 52-week low, golden/death cross, volume surge, distance from the 50-day average, trend break, your own take-profit and stop-loss. Each signal lists exactly which rules fired.
- **Insights:** total return for 1M/3M/this year/all time, gain or loss by month, best and worst holdings, dividend yield, realized gains, a concentration warning.
- **Settings:** commission, refresh interval, notifications (alerts, market-close summary, daily signals), backup/restore, CSV export, erase.

## Good to know

- Prices and history come from the public pages on old.dsebd.org, and the DSEX index from dse.com.bd. DSE retired the www.dsebd.org pages in Oct 2026. The data runs a few minutes behind live trading. Holidays aren't tracked.
- The 5/15/18-day lists download about 5 weeks of day-end prices for every stock (~12 MB). This happens at most every 3 hours.
- Alerts and signals are checked while the app is open or each time you open it. Android doesn't let a simple app poll a website every minute in the background.
- The whole-market scan downloads a year of history for every stock, about 400 requests. Run it on Wi-Fi. It takes a few minutes and is saved for the day.
- Signals are mechanical rules on price and volume. They ignore earnings, news and company health, and they are not investment advice.
- If DSE changes its website layout, the parsing is in `src/dse.js`.

## For developers

```bash
npm install
npm run build:web     # bundles src/ → www/app.js
npm run build:apk     # needs JDK 21 + Android SDK 36; APK at android/app/build/outputs/apk/release/
```

Browser preview: `npm run build:web`, serve `www/`, tap "Load demo prices" (browsers can't reach DSE directly).

```
src/app.js        screens, navigation, refresh loop, alerts, signals UI
src/dse.js        DSE fetching + parsing, market hours
src/portfolio.js  average-cost P/L, realized gains, dividends, alert checks
src/signals.js    RSI, moving averages, 52-week range, volume, rule evaluation
src/store.js      saved data, history cache, number formatting
src/demo.js       fake prices for offline preview
api/dse.js        server function for the website: fetches 3 fixed DSE pages (not an open proxy)
vercel.json       website build + hosting settings
```
