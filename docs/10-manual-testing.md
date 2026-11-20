# X Smart Monitor manual testing

Start with Test A. It runs locally without X credentials. Keep optional X and VM tests on disposable profiles, and use only accounts and credentials you control.

## Set up and preserve existing data

1. On Windows x64, quit the existing app through the tray. Open `release\Smart Monitor Setup 0.1.0.exe` from your local build and launch **Smart Monitor** from the Start menu. Local unsigned builds can show a Windows publisher prompt. Verify the artifact came from your own checkout before running it.
2. To run the same frontend and service in your browser instead, install Node.js 24, open PowerShell in `A:\srcaper`, and run:

   ~~~powershell
   npm ci
   npm run build
   npm run monitor -- open
   ~~~

3. For a clean test profile, set `$env:MONITOR_PROFILE = "$PWD\.local\manual-test"` before launching the worker. To use that profile with the desktop app, quit the running app and start `& "$PWD\release\win-unpacked\Smart Monitor.exe"` from that same shell. Clear the environment variable afterward if you want the default profile.
4. Before upgrading an important profile, use **Quit Smart Monitor** in the tray or `npm run monitor -- stop`, then copy the stopped profile directory to a private backup. The Windows default is `%LOCALAPPDATA%\X Smart Monitor`. The profile can include private watchlists, post excerpts, preferences, and notifications. Keep the backup private and restore a stopped profile as a unit. Credentials remain in the OS vault.

The upgrade adds no SQLite migration. Previous schema 3 profiles use the existing schema 4 migration. Collection diagnostics, session checkpoints, and selected excerpts use existing tables.

## Test A — Simulated monitoring

1. Open **Data sources** and confirm **Simulated** is selected. Open **Watchlists → Use SQLite example**. Select **Test watchlist** and confirm the example shows a match. Select **Save watchlist**.
2. From **Dashboard**, select **Start monitoring**. Open the SQLite release match. Confirm the post is labeled **Simulated**, the score reads **100**, and the details explain which terms and signals contributed.
3. Check **Notifications** for an immediate alert. Mark it read. With **Desktop notifications** enabled in Settings, the app also submits an OS notification. Select **Test desktop alert** in Notifications to check the OS channel separately.
4. Close the window, wait for another interval, and reopen using the tray. The worker should still be active. Quit through the tray, reopen, and confirm the watchlist, posts, and read state persist.
5. For delayed popularity, use a fresh profile and a single-word SQLite watchlist with a standard threshold of 75 and an immediate threshold above 83. Leave monitoring running for 15 minutes. The seeded likes-growth example should move from 65 to 83 and produce a delayed alert, subject to quiet hours, caps, and cooldown.

If no new results appear, check that a watchlist is enabled and monitoring is running. **Data sources → Replay simulation** queues a fresh synthetic timeline. Replayed seeded posts can have new IDs.

## Test B — Official X API

1. In the X Developer Console, use a developer app entitled to recent search and set and verify a provider-side spending limit first. Keep monitoring paused during setup.
2. From the Windows tray choose **Set X credential in terminal…**, or run `npm run monitor -- credentials set`. Paste the app-only bearer at the masked prompt. Keep it out of command lines, source files, screenshots, and support messages.
3. In **Settings → Live API budget**, set a daily request ceiling and a resource ceiling inside your approved spending allowance, then confirm the provider limit. One page of 10 results reserves 20 resources. The numbers are request and resource ceilings. X handles billing.
4. Create a watchlist with a literal word or phrase used in a public post from the last 15 minutes, or wait for the next matching post. Open **Data sources**, select **Use source** on **Official X API**, and select **Check connection**. The check consumes budget and can verify recent search independently of lookup or streaming.
5. Start monitoring. Allow for indexing and the delayed end of the search window. In **Post feed**, open the matching entry and check the X link, timestamps, available counters, matching watchlist, and scoring explanation. The app uses a local match summary and metadata for live posts. Read the full post on X.
6. In **Collection settings**, set **Pages per query per cycle** to 1 and use a query likely to return several pages within the authorized budget. Watch for a saved checkpoint and resume after a restart. Dashboard and Data sources show the last attempt, the latest attempt's counts, and bounds of fully completed windows. A gap message can mean the bounds contain discontinuities.
7. Check budget failure by lowering the local resource ceiling below the next request reservation. Expect **Budget paused** and a budget indicator. Check invalid credentials using Test E. Use the automated HTTP 429 fixture to verify reset behavior without spending X credits on extra requests. If X returns a real 429 during ordinary testing, wait for the reset and verify the saved window resumes.
8. Optional Filtered Stream requires a separately entitled endpoint and rules already set in your developer app. Turn it on only with an approved budget. A verified search still has its own connection status if stream access is denied.

If search returns no results, check the post's age, visibility, language, excluded terms, and enabled rules. If the connection reports **Access denied**, verify the app's entitlement for the exact endpoint. If the app says **Credits required**, check the provider console before retrying.

## Test C — Local X Account

1. Set the two X API budgets as described in Test B. For a stable OAuth redirect, quit the desktop or stop the browser worker, set `$env:MONITOR_PORT = '43123'`, and launch again from that shell. Choose a different free port if required.
2. Open **Data sources → Local X Account → Connect official OAuth**. In your X developer app, configure a public OAuth 2.0 client and register the exact redirect shown, including the port and `/api/v1/oauth/session/callback`.
3. Enter the public client ID. Select **Accounts I follow**, **Authors of posts I liked**, and **Allow refresh** only if you want those permissions. Select **Continue to X** and complete X’s consent screen. This is official OAuth authorization. Password entry and verification happen on X.
4. Verify the handle and OAuth expiry. Use the source, check recent search, then start monitoring a matching watchlist. If optional signals are available, check the last successful sync, follow and liked-author totals, and partial or complete state. A paginated follow list supplies known positive matches while the rest are unknown.
5. Quit and restart with the same profile. Verify the account and available data restore. To test expiry without changing system time, omit offline refresh in a disposable profile and wait for the access token to expire. Use **Reconnect official OAuth**. Select **Disconnect**, confirm the OAuth status and signals clear, and verify X collection stops. Revoke the grant in X if you also want to withdraw upstream authorization.
6. Confirm **Authenticated website-session collection** shows **Permission required**. Live website-session collection remains unavailable pending an expressly approved X mechanism. To save user-selected text, open a post in your browser, copy its direct permalink and the excerpt you choose, and use **Share selected X post**. Confirm local storage and select **View saved post**. It should open the chosen excerpt with an X link. An excerpt alone stays unresolved for matching, ranking and alerts.

If X refuses the redirect, check the exact URL, app type, and client ID. If an optional endpoint is denied or its result is incomplete, check the signal status independently of recent search. The approved browser workflow is manual paste with explicit consent and makes no X request.

## Test D — Hosted VM

You need a Linux VM you administer, Docker Engine with Compose, and a public DNS name pointing to the VM. Open inbound 80 and 443 for Caddy and keep the hosted worker port private. Configure and run in the checkout on that VM:

~~~sh
export HOSTED_DOMAIN=monitor.example.com
export HOSTED_MODE=simulated
export HOSTED_PROVIDER=simulation
docker compose -f services/hosted-collector/compose.yaml config --quiet
docker compose -f services/hosted-collector/compose.yaml up -d --build
docker compose -f services/hosted-collector/compose.yaml run --rm hosted client issue "Installation A"
docker compose -f services/hosted-collector/compose.yaml run --rm hosted client issue "Installation B"
~~~

1. Replace `monitor.example.com` with your DNS name. Use `https://your-hostname/health` to verify Caddy has a trusted certificate and the backend responds. If issuance fails, check DNS, ports, and `docker compose -f services/hosted-collector/compose.yaml logs proxy`.
2. Save each client ID privately for revocation and deliver the corresponding token only to that installation. Use two PCs or two user sessions with separate local profiles. Create enabled watchlists on both. Approve **sqlite** on both and give one client a second topic such as **database**. Use **Data sources → Configure hosted service** and select only those topics. Save each token with the tray action **Set hosted credential in terminal…** or `npm run monitor -- hosted-credential set`.
3. Check each connection, select **Hosted Monitoring**, and start monitoring. With the default interval, allow up to five minutes for a new poll. Both clients should see SQLite results. Only the subscribed client should receive its second topic. Confirm the provider is **Simulation**, posts are simulated, and ranking is local.
4. Keep both clients running and execute `docker compose -f services/hosted-collector/compose.yaml restart hosted`. Verify it reconnects without asking for a new token. Events after the saved cursor are replayed during the unexpired subscription lease. Check for duplicate alerts. A client offline beyond the lease or delivery retention may have an explicit coverage gap.
5. Revoke client B with `docker compose -f services/hosted-collector/compose.yaml run --rm hosted client revoke <client-id>`. B should lose access, including its SSE connection. A should keep its own subscriptions.
6. Enable live VM delivery only after confirming both collection and redistribution authorization for the selected fields. Follow the VM setup guide to mount an operator-controlled encryption key, set the approved publication mode, provide a permission reference, cap X spending, and store a server-owned credential. Live mode requires `HOSTED_PROVIDER=official-api` or the matching inferred default. `HOSTED_IDENTITY` selects one explicitly named credential per worker. `credential status <identity>` shows health without printing the secret. `credential revoke <identity>` withdraws local access. Restart the service after changing the selected credential. [VM and operator setup](09-multi-source.md#deploy-the-hosted-service-on-a-vm)

If a desktop rejects the server URL, use a public HTTPS origin on 443. The production client rejects loopback, private, and reserved IPs. In **IDs** delivery, expect an unresolved record and an original X link. Keyword and exclusion checks, scores, and alerts require authorized post text. The VM reports authenticated website-session collection as unsupported. Selecting that provider in server configuration fails explicitly.

## Test E — Security and recovery

1. In a disposable profile, note a saved watchlist, a post, and a read alert. Disconnect the active real source. Confirm the monitor pauses and prior history stays accessible under its source. Check **Data sources** after quitting and restarting. Confirm the disconnected credential no longer connects.
2. For the browser setup, run `npm run monitor -- stop` and then `npm run monitor -- open`. Confirm the same watchlist, post and notification are present. Use a new launcher link after a restart.
3. With an explicitly approved budget on a disposable developer app, enter a deliberately invalid bearer in the masked prompt and use **Check connection**. Expect a credential error. Cancel the test and disconnect. Use the fixtures for entitlement, malformed body, budget and rate-limit errors without live traffic.
4. Reopen a profile after an alert was submitted. Confirm the canonical post has only one notification. Switch between configured collectors for a post both can see and check that the same canonical X post still has one alert. A dispatch interrupted during shutdown may read **Delivery unknown** and stays in history.
5. Inspect **Data sources**, the local redacted service log and the Network panel. Expect public metadata, budgets, and capability states, without X tokens, VM bearer tokens, cookie values from X, or user passwords. The browser uses its own local monitor session. Keep terminal token-issuance output and the private profile out of support artifacts.
6. To verify erasure, use only a disposable profile. Review **Settings → Erase local profile** and confirm the displayed profile before typing `ERASE`. This removes saved local content and credentials for that profile.

## Local verification commands

~~~powershell
npm run typecheck
npm run lint
npm test
npm run build
npm run build:hosted
npm run test:hosted
$env:PLAYWRIGHT_BROWSERS_PATH = "$PWD\.local\browsers"
npx playwright install chromium
npm run test:e2e
npm run test:performance
$env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
npm run desktop:package -- --win --x64 --publish never
npm run test:desktop:win
~~~

The protocol, browser and desktop tests require local loopback sockets. Automated X tests use fixture responses. Public TLS, real X entitlement, real publication permissions, signed installation, and native macOS/Linux verification need manual acceptance.

### Results for this build

- Type checking and linting passed. All 26 service tests and three Chromium tests passed.
- The production Next.js, local Node.js, and hosted builds passed. The hosted bundle and the isolated Linux container both delivered a simulated post over authenticated SSE. Compose configuration and Caddy configuration validation passed.
- The Windows x64 NSIS installer was rebuilt unsigned. The unpacked app passed worker startup, window-close polling, durable notification history, tray-host activation, and clean shutdown. The desktop reported a test notification as submitted.
- The local feed benchmark measured 40 ms p95 over 30 queries with 10,000 posts and 20 watchlists.
- Real X endpoints and a public VM were outside local verification. Website-session networking remains unavailable without explicit authorization.

## Changed files

- Repository handling — `.dockerignore`, `.gitignore`, `docs.zip`, `tree.zip`. The two archives were removed from Git tracking. Both local copies remain. `docs.zip` contained archived planning documents. `tree.zip` contained a directory listing.
- Local backend — `apps/service/api.ts`, `apps/service/cli.ts`, `apps/service/hosted-client.ts`, `apps/service/monitor.ts`, `apps/service/rank.ts`, `apps/service/storage.ts`, `apps/service/website-session.ts`, `apps/service/x-api.ts`.
- Frontend and shared types — `apps/web/components/client.ts`, `apps/web/components/preferences.tsx`, `apps/web/components/workspace.tsx`, `packages/collection-core/hosted.ts`, `packages/collection-core/x-protocol.ts`, `packages/contracts/index.ts`.
- VM service — `services/hosted-collector/compose.yaml`, `services/hosted-collector/src/main.ts`, `services/hosted-collector/src/provider.ts`, `services/hosted-collector/src/service.ts`.
- Tests — `tests/completion.test.ts`, `tests/browser/monitor.spec.ts`.
- Documentation — `README.md`, `docs/09-multi-source.md`, `docs/10-manual-testing.md`.
