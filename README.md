# X Smart Monitor

Smart Monitor runs a local background service that collects posts, applies watchlist rules, scores matches and records alerts. The browser dashboard and optional desktop shell use the same service and SQLite profile.

## Run the browser application

Install Node.js 24.15 or newer in the 24.x series, then run from the project folder:

~~~sh
npm ci
npm run build
npm run monitor -- start
npm run monitor -- open
~~~

Choose **Watchlists → Use SQLite example**, preview the rule, and save it. Start monitoring on the Watchlists or Dashboard screen. A new installation opens in **Simulated** mode with monitoring paused and the paid budget set to zero. Using the example produces a score-100 immediate match. A second watchlist with the single word SQLite lets you see the likes-only 65 → 83 growth example over 15 minutes, subject to cooldown and other settings.

Closing the tab leaves the service active. Use `npm run monitor -- status`, `pause`, `resume` or `stop` to control it. Use `npm run dev` for a foreground service with a freshly built UI. Open a second terminal and run `npx tsx apps/service/cli.ts open` to connect to that service.

The service listens on 127.0.0.1. The launcher issues a short-lived, single-use session link. Reopen from the launcher after a service restart or session expiry. Use `MONITOR_PROFILE` for a dedicated alternate profile. Defaults are:

| OS | Profile |
| --- | --- |
| Windows | `%LOCALAPPDATA%\X Smart Monitor` |
| macOS | `~/Library/Application Support/X Smart Monitor` |
| Linux | `$XDG_DATA_HOME/x-smart-monitor` or `~/.local/share/x-smart-monitor` |

The profile contains `monitor.sqlite`, runtime coordination data and the redacted service log. Stop the service before upgrading it. If a disposable simulation completes, **Data sources → Replay simulation** schedules a fresh copy of the synthetic timeline and retains prior results. **Settings → Erase local profile** erases posts, alerts, settings, watchlists, and stored credentials after confirmation.

## Configure official X collection

1. Register a developer app authorized for recent search and post lookup. Set a spending limit in the X Developer Console.
2. Run `npm run monitor -- credentials set` in an interactive terminal and enter your **app-only bearer** at the masked prompt. The worker stores it in the OS credential vault. On a machine without an available vault, simulated mode remains usable.
3. Open Settings, enter positive daily request, resource and USD ceilings, enter a verified maximum unit price for all requested resource classes, and confirm the provider-side limit. An explicit **Check connection** runs a bounded recent search. To perform one capped acceptance probe with the worker paused, see Test B in the [manual guide](docs/10-manual-testing.md).
4. For optional follow and liked-author signals, register the **exact** redirect URL shown in Data sources and use a public OAuth 2.0 client. For a stable port, stop the worker and set `MONITOR_PORT` before starting it again. Daily refresh requires separate consent. Disconnect clears the local token and relationship signals. Revoke the app in X to withdraw upstream consent.

The official adapter polls recent search, reserves resources before requests, and reports coverage gaps. You can configure page limits and opt in to Filtered Stream using the rules on your X developer app. The same local ranker handles both transports. Live X previews use match summaries, source metadata and X links. [Collection feasibility](docs/03-collection.md)

**Local X Account** uses official OAuth and keeps credentials in the OS vault. Authenticated website-session collection requires separate X permission. You can save an excerpt you select in your own browser using **Share selected X post** in Data sources. **Hosted Monitoring** accepts an operator-issued token and subscribes to public topics you explicitly approve, with local ranking and notifications. See the [multi-source setup and VM guide](docs/09-multi-source.md) and the [manual acceptance tests](docs/10-manual-testing.md).

## Build desktop packages

After `npm run build`, package on the target OS and CPU architecture with `npm run desktop:package -- --publish never`. Windows uses NSIS, macOS uses DMG and ZIP, and Linux uses AppImage, DEB and RPM. To build an unpacked Windows bundle for a smoke test, use `npm run desktop:package -- --dir --win --x64 --publish never`. The packaging script stages a checksum-verified Node runtime and its SQLite binding alongside Electron. Output is under `release`.

The desktop tray supervises the local worker, can pause and resume monitoring, and keeps the worker active when its window closes. **Quit Smart Monitor** stops the worker it manages. Packaged builds offer login launch and **Set X credential in terminal**. On Linux, disable login launch from the tray before uninstalling, and update with the package manager. On Windows/macOS, the update menu requires publisher signing and a configured provider. Erase the profile before removing the application if you also want to clear local data and stored credentials.

## Run verification

~~~sh
npm run typecheck
npm run lint
npm test
npm run build
~~~

For browser tests, install Chromium to `.local/browsers` and run `npm run test:e2e`. In PowerShell:

~~~powershell
$env:PLAYWRIGHT_BROWSERS_PATH = "$PWD\.local\browsers"
npx playwright install chromium
npm run test:e2e
~~~

The browser test opens an actual detached loopback worker against a temporary profile. Ordinary automated tests use X fixtures and local SSE clients. Use `npm run test:performance` for the in-process benchmark, `npm run test:desktop` for the current platform's unpacked package, and `npm run test:desktop:dev` for the development launcher. See the [release verification record](docs/11-release-readiness.md) for current results and external requirements.
