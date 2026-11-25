# Manual acceptance

Use Node.js 24.15 or newer in the 24.x series for source builds. Run `npm ci` and `npm run build`. Use a disposable profile before changing sources. In PowerShell, set `$env:MONITOR_PROFILE = "$PWD\.local\manual-win"` and launch the unpacked desktop from that terminal. For a browser-only run, use `npm run monitor -- open`. The installed app defaults to `%LOCALAPPDATA%\X Smart Monitor` on Windows. Stop the app before copying a valued profile.

## Test A — Local X Account

1. In the desktop app, open **Data sources → Open X sign-in**. Select **Remember my sign-in** first if you want restoration on a trusted device. Complete any email verification or MFA directly in the X window.
2. Confirm the account in the X window and choose **Check browser session** in Smart Monitor. A detected local cookie is reported as **Connected**. The **Session collection** row remains **Unsupported**. Username verification in Smart Monitor and automated search need an approved X interface.
3. Quit and relaunch. For a saved session choose **Check browser session** again. A missing cookie requires sign-in. If X displays a challenge or restriction, follow the instructions in X. If secure storage is unavailable, an unsaved browser session lasts for the current app process.
4. Choose **Disconnect browser**. Verify that reopening asks you to sign in. The action clears the app's X browser data.
5. Copy a direct X post permalink and an excerpt, then choose **Share selected X post** and confirm local storage. Verify the excerpt appears in Post details as **User-shared** and creates no keyword notification.

A browser login does not exercise automated collection. For the authorized-driver fixture run `npm test`. The fixture covers search, paging, limits, failure, reconnect, ranking and notification dispatch.

## Test B — Hosted Monitoring

1. Start a simulated server and issue two tokens using the [VM guide](09-multi-source.md). Use separate desktop profiles. Approve OpenAI and NVIDIA on A, and OpenAI and Microsoft on B.
2. Check both connections, select **Use Hosted Monitoring** and start monitoring. Verify both receive OpenAI, only A receives NVIDIA, and only B receives Microsoft. Check local ranking and one notification per post.
3. Disconnect and reconnect A, then restart the server. Verify that eligible missed events replay without repeated alerts or changes to B's subscriptions. Revoke A and confirm that its token cannot reconnect.
4. For a configured HTTPS test VM, run `npm run monitor -- verify-hosted --confirm-vm` to check an authenticated retained simulated event. **Publication unavailable** means the VM is disabled. **Collection unsupported** indicates the VM did not report an approved source for live delivery.
5. Leave live acceptance blocked until an approved provider and publication rights exist. A future live acceptance requires an observable authorized search and delivery of only the reviewed fields to both clients.

## Test C — Regression and desktop notifications

1. Select **Simulated**, choose **Watchlists → Use SQLite example → Test watchlist**, save the rule and start monitoring. The simulated release should score 100 and appear in notification history. Mark it read.
2. Close the window to the tray while the worker runs. Reopen from the tray and verify history. Quit and restart. Recheck the same list, post, and read state.
3. In **Settings → Send test notification**, check that a visible OS banner appears. Enable **Desktop notifications** and **Allow desktop notifications for simulated posts** to test a replay toast while minimized. Click the toast and verify it opens the matching post. Check Windows Notification Center, Smart Monitor notification permissions and Do Not Disturb if the API reports submitted and the banner is hidden.
4. In a disposable profile enable quiet hours or set the daily cap to zero, replay, and verify that new desktop notifications are suppressed. Undo those settings. Set a word-only SQLite watchlist with standard threshold 75 and immediate threshold above 83 to observe the delayed popularity example while the worker runs.
5. Open a copied previous profile. Verify earlier data using **Feed → Source → Earlier X collection**. An upgrade from a retired collector selects Simulated and pauses. Start it only when you want to see test data.

## Desktop platform checks

Package on the native target architecture with `npm run desktop:package -- --publish never` after `npm run build`. Then run `npm run test:desktop`. Linux packaging requires `binutils`, `xz-utils`, `rpm`, `libarchive-tools`, `fakeroot` and `desktop-file-utils` on Ubuntu. Use FUSE support for AppImage or install the native DEB/RPM. On both macOS architectures, check Keychain, menu-bar behavior, OS notifications and signing. On Linux check the desktop's Secret Service, XDG profile, tray support, login launch and visible notifications. Test OS banners in an interactive session. [Release status](11-release-readiness.md)
