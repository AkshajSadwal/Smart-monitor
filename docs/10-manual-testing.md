# X Smart Monitor manual acceptance

Start with Test A on Windows. The simulated end-to-end flow works without X credentials, network access to X, or a VM. Use disposable profiles for later tests. The current release status and changed files are in [Release readiness](11-release-readiness.md).

## Prerequisites and profile safety

- Use Node.js **24.15 or newer in the 24.x series** for source builds. From the checkout run `npm ci`, `npm run build`, and `npm run monitor -- open`. Run `npm run monitor -- stop` to stop the browser-launched service. Use **Quit Smart Monitor** from the tray to stop the desktop-managed worker.
- To use an isolated Windows profile, run `$env:MONITOR_PROFILE = "$PWD\.local\manual-win"` in PowerShell before starting the unpacked executable or CLI. The installed app's default profile is `%LOCALAPPDATA%\X Smart Monitor`. macOS and Linux paths are listed below.
- Before upgrading a valued profile, quit the app and copy the stopped profile directory to a private backup. Restore it only while the app is stopped. SQLite schema 4 remains in use. Hosted tables for expiry, acknowledgements, replay coverage and delivery limits are additive.
- Existing X credentials and usage history are preserved. Paid reads remain blocked until the profile has a positive USD ceiling and a verified maximum resource price as described in Test B.
- After a worker restart use **Open Smart Monitor** or `npm run monitor -- open` for a fresh launcher session. Never include auth cookies, bootstrap links, vault data, VM-issued tokens, or real profile archives in support screenshots or logs.

## Test A — Simulated monitoring

1. Launch the installed Windows **Smart Monitor**, or run `npm run monitor -- open`. Set **Data sources → Simulated** if an existing profile uses another source.
2. Open **Watchlists → Use SQLite example → Test watchlist**. Confirm a match, then save it. From **Dashboard** choose **Start monitoring**.
3. Open the SQLite release post. It should be labeled **Simulated**, score **100** with the example rule, and display scoring details. **Notifications** should show an immediate history entry. Mark it read.
4. Close the window and reopen from the tray after a collection interval. The worker should still be active. Then quit and restart. Verify the watchlist, posts, alert, and read state survived.
5. Use a fresh profile for a delayed-growth example. Add a single-word SQLite rule with standard threshold 75 and immediate threshold above 83. Over approximately 15 minutes the seeded score can rise from 65 to 83 and enter alert history, subject to cooldown, quiet hours, and the cap.

If the dashboard stays paused, enable a watchlist first. **Data sources → Replay simulation** queues fresh synthetic IDs. Native simulated toasts are off by default. Test F covers the explicit opt-in.

## Test B — Official X API

1. Use an X developer app with recent search enabled. In its console, inspect current prices for posts and expansions and set a provider-side spending limit. Choose a small local test budget. Do not continue if you cannot bound the charges. [X pricing](https://docs.x.com/x-api/getting-started/pricing)
2. Set the app-only bearer at a masked prompt using the tray's **Set X credential in terminal…** or `npm run monitor -- credentials set`. Do not put the token in the command line or a file.
3. In **Settings → Live API budget**, provide positive request, resource and US-cent limits and enter the maximum approved price per resource in millionths of USD. For example, `10000` means USD 0.01. Use that value only if the console confirms it bounds every requested resource class. A 10-result search page with expansions reserves 20 resources. Verify the estimate displayed in **Data sources** before proceeding.
4. Create an enabled literal watchlist for a public post from the last 15 minutes, or wait for a new match. Keep polling paused. Use **Official X API → Check connection** for one recent-search page. Alternatively, run the acceptance probe instead of the UI check:

   ~~~powershell
   npm run monitor -- verify-x --confirm-paid --cap-cents=25
   ~~~

   Choose an approved cap of 1–100 US cents. The command uses the existing OS vault and refuses a reservation above the local daily or probe cap. It reports the normalized post count and a saved checkpoint, without logging cursor values. Zero posts is valid for a correctly authorized empty search. `NOT TESTED — CREDENTIALS REQUIRED` means the probe made no X request.
5. If you want background testing inside your budget, use **Use source** and start monitoring. Check the permalink, counters, coverage and ranking. Try a one-page limit and restart with a saved cursor. Use fixtures for deliberate invalid responses and 429s. Do not create real rate-limit traffic.

**Invalid credentials** means X rejected the token. **Access denied** indicates an entitlement or scope issue. **Budget paused** indicates a local ceiling. **Rate limited** requires waiting for reset. **Network unavailable** and **Endpoint unavailable** distinguish transport failure from an upstream response. Clear or replace credentials and resume only after reviewing the console. For Filtered Stream, leave it off unless the app is entitled and the provider enforces an acceptable hard spending limit independent of local cancellation.

## Test C — Local X OAuth

1. Configure the budgets from Test B. Use a stable loopback port for the X public OAuth client. In PowerShell, after stopping the worker, run:

   ~~~powershell
   $env:MONITOR_PORT = '43123'
   npm run monitor -- open
   ~~~

2. In **Data sources → Local X Account → Connect official OAuth**, copy the exact redirect URI shown, including `/api/v1/oauth/session/callback`. Register it in the X developer app. Enter the public client ID. Select following, liked authors, and offline refresh only if you want those permissions.
3. Complete the X-controlled browser consent screen. Verify the shown account handle and expiry. With an enabled rule, check search. For a paused optional acceptance probe, use `npm run monitor -- verify-oauth --confirm-paid --cap-cents=25` instead of the UI check. An expired access token may need refresh. The acceptance probe sends at most one search request.
4. If optional scopes are authorized, select the source and start monitoring. Verify following or liked-author counts, sync progress and the last success. Partial following coverage gives positive matches only.
5. Restart on the same profile and port. Revoke a grant in your test X account, or use an account without offline refresh and wait for expiry. Verify that the expired source requests reconnection and stale relationship data is cleared when the service confirms revocation. Reconnect and ensure the expected handle returns. Use **Disconnect** to clear local credentials.

If the authorization code is rejected, verify the redirect and restart sign-in. Codes and state are one time. A denied optional scope can leave search available. Stop polling and disconnect after testing.

## Test D — Local authenticated website integration

**Unsupported for live collection.** The authorization, page, rate-limit and reconnect interface is fixture-tested. Official OAuth in Test C uses documented X APIs. It does not provide browser-cookie or website collection access.

After opening a post in a browser, you can voluntarily copy its direct permalink and selected text into **Data sources → Local X Account → Share selected X post**. Approve local storage and choose **View saved post**. The excerpt should be labeled user-shared. The entered excerpt cannot rank, hydrate, or notify. A non-X or non-post URL should be rejected. This manual workflow sends no request to X. Optionally enable **Offer official X embeds** in Settings if your use and privacy disclosures are approved, then choose **Agree and load X embed** on one public post. Verify the official widget and its permalink manually.

## Test E — Hosted VM

1. Use a Linux VM you control, Docker Compose, a public DNS name, and access to ports 80 and 443 for Caddy. Leave the Fastify worker's port private. From the checkout on the VM run:

   ~~~sh
   export HOSTED_DOMAIN=monitor.example.com
   export HOSTED_MODE=simulated
   export HOSTED_PROVIDER=simulation
   docker compose -f services/hosted-collector/compose.yaml config --quiet
   docker compose -f services/hosted-collector/compose.yaml up -d --build
   docker compose -f services/hosted-collector/compose.yaml run --rm hosted client issue "Installation A"
   docker compose -f services/hosted-collector/compose.yaml run --rm hosted client issue "Installation B"
   ~~~

2. Replace the example name with your domain and verify `https://your-hostname/health` returns JSON with a trusted certificate. If it fails, check DNS and ports, then run `docker compose -f services/hosted-collector/compose.yaml logs proxy`.
3. On two independent installations, save enabled one-keyword watchlists for OpenAI and NVIDIA on A, and OpenAI and Microsoft on B. In **Configure hosted service**, supply the public HTTPS origin, approve exactly the installation's topics and save the corresponding token using **Set hosted credential in terminal…** or `npm run monitor -- hosted-credential set`. Keep the two token IDs for operator revocation. New tokens expire after 30 days by default.
4. Check the connection, select **Hosted Monitoring**, and start. Verify both see OpenAI. A sees NVIDIA only and B sees Microsoft only. If using the source CLI on the same profile, `npm run monitor -- verify-hosted --confirm-vm` can independently verify authenticated HTTPS and a retained approved simulated SSE event. The probe opens a separate SSE connection with the same token and can briefly reconnect the desktop's stream.
5. Interrupt networking on A briefly while B keeps monitoring. Restore A. Restart only the VM worker with `docker compose -f services/hosted-collector/compose.yaml restart hosted`. Check replay and canonical deduplication. After expiry, a gap message is expected for replay outside the retained window.
6. Revoke B with `docker compose -f services/hosted-collector/compose.yaml run --rm hosted client revoke CLIENT_ID`. B should lose access without affecting A. Issue a replacement for B to retest. For expiry use `HOSTED_TOKEN_TTL_HOURS` on issuance or the automated short-lived fixture.
7. For an approved live test, separately configure the operator vault key, named app-only credential, current maximum resource rate, daily spend cap, permission reference and applicable recipient terms. Start with IDs. Metadata and full-record modes require written approval covering automated redistribution, fields and caching. The recommended scope-check procedure and all variables are in the [VM deployment guide](09-multi-source.md#deploy-the-hosted-service-on-a-vm) and the [content policy](12-content-compliance.md).

A private IP, nonstandard port, or redirect is rejected by the desktop. Token expiry calls for reissuance. An ID-only event should be unresolved. If you want it ranked, explicitly enable **Use my local X API budget to look up unresolved Hosted posts** and provide a budgeted local X credential. Failed lookups remain unresolved.

## Test F — Windows notifications

1. Install the unsigned NSIS build from your trusted checkout on Windows x64. Right-click the tray and ensure **Smart Monitor** is running. In PowerShell, run `Get-StartApps | Where-Object { $_.Name -eq 'Smart Monitor' }` to inspect the Start entry. The package uses AppUserModelID `local.smartmonitor.app`.
2. Open **Windows Settings → System → Notifications**. Enable notifications and banners for Smart Monitor. Temporarily turn off **Do not disturb** and any Focus session. Verify the Clock and quiet-hours zone in the app.
3. In Smart Monitor **Settings**, choose **Send test notification**. The UI should report OS submission or failure and give recovery guidance. Check the actual banner or Windows Notification Center. Submission confirms the notification path only.
4. Enable **Desktop notifications** and **Allow desktop notifications for simulated posts**. Save settings, start Test A, and minimize or close the window to the tray. A real synthetic banner should be labeled Simulated. Click it. It should restore the matching local detail. With an authorized X result, click its toast to open the original X post. Use test data and the approved budget only.
5. Pause monitoring, replay with quiet hours in force, or set the daily cap to zero in separate disposable tests. Expect suppression. Restart and confirm a previously submitted event is not resent. Undo the temporary test settings when done.

If Windows submits without a visible toast, check Notification Center, the Start shortcut, per-app settings, Do Not Disturb, and Focus. Development builds may have different Windows notification registration. Test the installed build for final visibility.

## Test G — macOS Intel and Apple Silicon

1. On each architecture, install Node.js 24.15 or newer in the 24.x series, run `node -p process.arch` and confirm x64 on Intel or arm64 on Apple Silicon. In the checkout:

   ~~~sh
   npm ci
   npm run build
   export CSC_IDENTITY_AUTO_DISCOVERY=false
   # Intel
   npm run desktop:package -- --mac --x64 --publish never
   # Apple Silicon
   npm run desktop:package -- --mac --arm64 --publish never
   npm run test:desktop
   ~~~

   Run only the line matching the native architecture. Use the generated package from a trusted local build. Signing and notarization credentials are required for the public release path that relies on Gatekeeper trust.
2. Launch the app from the DMG or unpacked bundle. Repeat Test A and verify that closing the window leaves a menu-bar icon. Reopen and quit from the menu. Verify data in `~/Library/Application Support/X Smart Monitor`.
3. With a permitted test credential and positive budget, use the terminal action to test the Keychain. Verify the app can reopen its profile after restart. Inspect Keychain authorization if storage is unavailable. Never use an exported token in place of the Keychain.
4. In macOS **System Settings → Notifications**, allow Smart Monitor and turn off Focus for the test. Use **Send test notification** and check the actual banner. Opt into simulated notifications to test click-to-open while the window is closed.

If a package cannot launch, verify architecture and system permissions. If macOS blocks an unsigned package, use a verified local development build or the approved signing and notarization process. A passing headless or CI smoke result does not confirm banner visibility.

For a signed release build, configure the Developer ID certificate through the operator's existing signing environment. For notarization, electron-builder supports externally supplied `APPLE_API_KEY`, `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER`. Keep the key file and all signing credentials out of the repo, package, and CI logs. Run the same native packaging command with signing enabled and keep `--publish never`.

## Test H — Linux x64

1. On a desktop Linux x64 system, install Node.js 24.15 or newer in the 24.x series and check `node -p process.arch`. Use:

   ~~~sh
   npm ci
   npm run build
   npm run desktop:package -- --linux --x64 --publish never
   xvfb-run -a npm run test:desktop
   ~~~

   Install your distribution's build and Xvfb prerequisites first. On Ubuntu, `binutils` supplies the `ar` tool used for DEB packaging. RPM packaging also requires `rpmbuild`. The [Ubuntu CI workflow](../.github/workflows/verify.yml) lists the package prerequisites. Select the AppImage or the package appropriate to your distribution.
2. Run the trusted AppImage with executable permission or install the generated DEB/RPM. If using the three local release-test packages, run `sha256sum -c SHA256SUMS-linux.txt` from the directory containing the packages and manifest. If the AppImage cannot mount, install the distribution's compatible FUSE support or use the native package. Run Test A and verify XDG storage under `${XDG_DATA_HOME:-$HOME/.local/share}/x-smart-monitor` and owner-only permissions.
3. Test the tray and login launch in your actual desktop session. If the environment hides status icons, enable its supported tray indicator. Disable **Launch at login** before uninstalling. Confirm background behavior and clean quit.
4. With an authorized credential and budget, test the OS Secret Service. It must be running in your user D-Bus session and unlocked. If the tray cannot start a terminal, enter the credential with the source CLI and the same profile. Use **Send test notification** and verify visibility through the desktop notification daemon. Opt into simulated notifications to test a non-X toast.

Missing Secret Service or a locked collection results in a local vault error. Missing D-Bus or a notification daemon can prevent toast display in containers and headless hosts. Keep X disabled until secure storage works. The Linux headless check verifies integration wiring only.

## Recovery and evidence

On a disposable profile, stop and restart the service, disconnect each configured source, and verify preserved posts, watchlists and read alerts. Use **Erase local profile** only when you intend to delete that profile's data and credentials. Keep screenshots and support logs free of secrets. To report an X check include its safe status code and whether a budget blocked the request. To report SSE include the simulated topics and whether expiry, revocation, or a replay gap occurred.
