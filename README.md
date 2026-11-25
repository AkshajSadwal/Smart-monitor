# X Smart Monitor

Smart Monitor runs a local background worker with a Next.js dashboard, SQLite history, watchlists, personalized ranking, popularity tracking and desktop alerts. The Electron desktop window and system tray use the same worker as the browser launcher.

## Run locally

With Node.js 24.15 or newer in the 24.x series, run these commands from the checkout.

~~~sh
npm ci
npm run build
npm run monitor -- open
~~~

In **Watchlists**, choose **Use SQLite example**, preview and save the rule, then start monitoring from **Dashboard**. A fresh profile opens in **Simulated** mode with monitoring paused. Closing the tab leaves the worker active. Use `npm run monitor -- status`, `pause`, `resume` or `stop` to control it.

For development desktop sign-in, stop any browser-launched worker first. In PowerShell:

~~~powershell
npm run monitor -- stop
npm run start -w @monitor/desktop
~~~

The app listens on loopback and issues a short-lived, single-use launcher URL. Use `MONITOR_PROFILE` for an alternate profile. Default locations are `%LOCALAPPDATA%\X Smart Monitor`, `~/Library/Application Support/X Smart Monitor` on macOS, and `${XDG_DATA_HOME:-~/.local/share}/x-smart-monitor` on Linux.

## Collection modes

- **Local X Account** opens a separate desktop window for manual X sign-in. Automatic collection requires an X-approved interface. Use **Share selected X post** or **Import posts** to score user-selected records locally.

- **Simulated** uses local seeded posts for testing. **Replay simulation** schedules fresh fixture IDs. Native toasts require the simulated-notifications opt-in.

Keep a stopped profile backup before upgrading. Schema 6 preserves historical posts, scores, feedback and alerts. A profile using a retired collector opens with simulation paused. View saved history using the Feed or Notifications source filter. Use `npm run monitor -- cleanup-retired-credentials --confirm` to clear credentials from retired sources.

[Local collection and JSON format](docs/03-collection.md) · [Manual tests](docs/10-manual-testing.md)

### Python setup for twscrape

Run from the checkout in PowerShell with Python 3.10 or newer.

~~~powershell
New-Item -ItemType Directory -Force .local\temp | Out-Null
$env:TEMP = (Resolve-Path .local\temp).Path
$env:TMP = $env:TEMP
python -m venv .local\twscrape-venv
& .\.local\twscrape-venv\Scripts\python.exe -m pip --isolated install --no-cache-dir -r apps\service\python\requirements.txt
~~~

In **Data sources → Local X Account → Import posts**, select a `.jsonl` file of twscrape post records you have permission to use, up to 50 posts or 60 KB. The import runs locally, applies watchlists and ranking, and creates no notifications.

### Authorized live collection on Windows

Use this launch option only on an account authorized for automated reads through twscrape. Quit an already-running desktop instance from the tray before launching.

~~~powershell
npm.cmd run build
$env:MONITOR_TWSCRAPE_LIVE = '1'
npm.cmd run start -w @monitor/desktop
~~~

In **Data sources → Local X Account**, sign in, confirm your X profile, and select **Enable collection → Use Local X Account**. Enable a watchlist and use **Start monitoring** in the top bar. The Dashboard and Data Sources show the next scheduled collection and rolling request usage. Change the interval under **Settings → Monitoring and alerts**. Choose **Local X Account** in the Post feed to see available cached previews and open originals on X. Leave the flag unset to use browser sign-in and manual imports alone.

The adapter uses the current confirmed Electron session. Request limits are shared across operations in the local profile and survive restarts and reconnects. The app uses one account at a time. Following sync includes up to 100 accounts per day. Live liked-post retrieval is unavailable in the pinned package.

The service uses the venv path above. Set `MONITOR_PYTHON` to an absolute interpreter path for a different local Python environment. Desktop packaging stages the worker script with the service. The launcher can use a future bundled interpreter under `resources/python-runtime`, but the current package does not include Python.

## Package and verify

Run `npm run desktop:package -- --publish never` after building on the target OS and architecture. Packages are staged under `release`. Windows uses NSIS, macOS uses DMG and ZIP, and Linux uses AppImage, DEB and RPM. **Quit Smart Monitor** stops the worker the desktop app owns. Configure launch at login from the tray.

~~~sh
npm run typecheck
npm run lint
npm test
npm run test:desktop:dev
~~~

Set `PLAYWRIGHT_BROWSERS_PATH` to a workspace cache, then run `npx playwright install chromium` and `npm run test:e2e`. Use `npm run test:desktop` after native packaging and `npm run test:performance` for the local benchmark.
