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

- **Local X Account** opens a separate desktop window for manual X sign-in. Manual email verification and multifactor prompts belong to X. Automatic X search requires an approved interface. You can save a permalink and excerpt you select with **Share selected X post**.
- **Hosted Monitoring** accepts a server-issued client token and sends only approved public topics. Ranking and alerts run locally. The bundled collector supports hosted simulation over authenticated SSE. Live hosted collection requires a separately authorized provider and redistribution rights.
- **Simulated** uses local seeded posts for testing. **Replay simulation** schedules fresh fixture IDs. Native toasts require the simulated-notifications opt-in.

Keep a stopped profile backup before upgrading. Schema 5 preserves historical posts, scores, feedback and alerts, and pauses profiles that used a retired source. Use **Earlier X collection** in the Feed's source filter to see historical API results. Retired OS vault entries remain until `npm run monitor -- cleanup-retired-credentials --confirm` or explicit profile erasure.

[Source setup and VM guide](docs/09-multi-source.md) · [Manual tests](docs/10-manual-testing.md)

## Package and verify

Run `npm run desktop:package -- --publish never` after building on the target OS and architecture. Packages are staged under `release`. Windows uses NSIS, macOS uses DMG and ZIP, and Linux uses AppImage, DEB and RPM. **Quit Smart Monitor** stops the worker the desktop app owns. Use the tray menu to enter a server-issued token or configure launch at login.

~~~sh
npm run typecheck
npm run lint
npm test
npm run build:hosted
npm run test:hosted
npm run test:desktop:dev
~~~

Set `PLAYWRIGHT_BROWSERS_PATH` to a workspace cache, then run `npx playwright install chromium` and `npm run test:e2e`. Use `npm run test:desktop` after native packaging and `npm run test:performance` for the local benchmark. [Verification results](docs/11-release-readiness.md)
