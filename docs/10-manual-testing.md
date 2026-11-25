# Manual acceptance

Use Node.js 24.15 or newer in the 24.x series for source builds. Run `npm ci` and `npm run build`. Use a disposable profile before changing sources. In PowerShell, set `$env:MONITOR_PROFILE = "$PWD\.local\manual-win"` and launch the unpacked desktop from that terminal. For a browser-only run, use `npm run monitor -- open`. The installed app defaults to `%LOCALAPPDATA%\X Smart Monitor` on Windows. Stop the app before copying a valued profile.

## Test A — Local X Account

1. In the desktop app, open **Data sources → Open X sign-in**. Select **Remember my sign-in** first if you want restoration on a trusted device. Complete any email verification or MFA directly in the X window.
2. Choose **Check browser session** in Smart Monitor. In the X window choose **Profile** from X’s navigation. When your profile shows **Edit profile**, return to Smart Monitor and choose **Confirm my X profile**. Smart Monitor takes the handle from the profile URL and marks the browser sign-in **Confirmed by you**. **Session collection** remains **Unsupported**.
3. Quit and relaunch. The previously confirmed handle should appear automatically for the same saved session. An older installation or a replaced session cookie may need one profile confirmation. If X shows a challenge or restriction, follow its instructions. A Google-linked account can use an alternate email or password method when X offers it. [Google OAuth policy](https://developers.google.com/identity/protocols/oauth2/policies#secure-browser)
4. Choose **Disconnect browser**. Verify that reopening asks you to sign in. The action clears the app's X browser data.
5. Copy a direct X post permalink and an excerpt, then choose **Share selected X post** and confirm local storage. Verify the excerpt appears in Post details as **User-shared** and creates no keyword notification.

For the Local X Account regression, run `node --import tsx --test tests/session.test.ts` and `npm run test:desktop:dev -- --account-only` after building. Real keyword collection needs an X-authorized session endpoint or integration covering search and pagination, plus explicit access to following and likes for those signals. X's documented collection APIs use developer credentials. [X Automation Rules](https://help.x.com/en/rules-and-policies/x-automation)

## Test B — Manual posts

1. Create and enable a watchlist. In **Data sources → Local X Account**, choose **Import posts → Download JSON example**. Edit the array using the [JSON format](03-collection.md).
2. Choose the JSON file, confirm local storage, and select **Import selected file**. Select **View manual posts**. Verify the new post is marked **Manual import** and any watchlist matches show their score. The import should create no alert.
3. Reimport the same file. Confirm there is one feed row per post. Change a supplied metric and import the new observation to see it in Post details.

## Test C — Regression and desktop notifications

1. Select **Simulated**, choose **Watchlists → Use SQLite example → Test watchlist**, save the rule and start monitoring. The simulated release should score 100 and appear in notification history. Mark it read.
2. Close the window to the tray while the worker runs. Reopen from the tray and verify history. Quit and restart. Recheck the same list, post, and read state.
3. In **Settings → Send test notification**, check that a visible OS banner appears. Enable **Desktop notifications** and **Allow desktop notifications for simulated posts** to test a replay toast while minimized. Click the toast and verify it opens the matching post. Check Windows Notification Center, Smart Monitor notification permissions and Do Not Disturb if the API reports submitted and the banner is hidden.
4. In a disposable profile enable quiet hours or set the daily cap to zero, replay, and verify that new desktop notifications are suppressed. Undo those settings. Set a word-only SQLite watchlist with standard threshold 75 and immediate threshold above 83 to observe the delayed popularity example while the worker runs.
5. Open a copied previous profile. Verify earlier data using **Feed → Source → Earlier X collection**. An upgrade from a retired collector selects Simulated and pauses. Start it only when you want to see test data.

## Desktop platform checks

Package on the native target architecture with `npm run desktop:package -- --publish never` after `npm run build`. Then run `npm run test:desktop`. Linux packaging requires `binutils`, `xz-utils`, `rpm`, `libarchive-tools`, `fakeroot` and `desktop-file-utils` on Ubuntu. Use FUSE support for AppImage or install the native DEB/RPM. On both macOS architectures, check Keychain, menu-bar behavior, OS notifications and signing. On Linux check the desktop's Secret Service, XDG profile, tray support, login launch and visible notifications. Test OS banners in an interactive session.
