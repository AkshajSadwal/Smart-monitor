# Technical architecture

## Two responsibilities, one installed service

Use an npm workspace and TypeScript. Next.js App Router, React and Tailwind own presentation. Export fixed routes as static assets with client-side data loading. Use /feed?post=… for detail deep links so new post IDs work after build. Fastify serves those assets and /api/v1 on one loopback origin. Start with Node 24 LTS and better-sqlite3, pin exact compatible versions in the lockfile, and verify native binaries for every distribution target. Production requires one service process. A browser is a replaceable viewer. [Next.js static exports](https://nextjs.org/docs/app/guides/static-exports)

~~~text
apps/web/          app routes, components, mascot, local fonts and styles
apps/service/      CLI, HTTP, scheduler, collectors, ranking, notifications, storage
packages/contracts/ shared runtime schemas, DTOs and event names
config/            checked-in nonsecret defaults and example configuration
fixtures/          synthetic timelines, account signals and HTTP response fixtures
tests/             integration, browser and lifecycle tests
docs/              product and engineering specifications
apps/desktop/      added in phase 5 for tray, packaging and OS integration
~~~

~~~text
due job → collector → normalized candidates → watchlist matching → scores
               │                                      │
       capabilities / health               one SQLite transaction
                                                      │
                             feed + history + dispatch job + cursor
                                          │                 │
                             REST snapshot + SSE      native notifier
~~~

## Runtime and lifecycle

- Provide CLI commands start, open, status, pause, resume and stop. start launches one detached current-user process with redirected, redacted rotating logs and waits for readiness. An optional foreground flag serves development. open can start the service and obtains a one-time UI bootstrap. Pause is durable across restarts. stop cancels collection and exits. Closing the last tab does nothing to the service.
- Use an OS-held single-instance lock or exclusive local control socket with user-only permissions and a readiness handshake. Bind HTTP to 127.0.0.1 on an available port and save its address in a user-private runtime directory. A repeated start attaches to the existing instance. Surface permission, port and migration failures with actionable status. Do not kill an unrelated process based on a stale PID.
- Store data under the OS's per-user application-data path, configurable for tests. SQLite WAL, foreign keys, busy timeout, transactional versioned migrations and one writer. Keep HTTP and SQLite batches short. Stagger due jobs and run at most one upstream read at once. Schedule from the next due timestamp. Wake on settings changes and OS resume. No active lists means no search traffic.
- Persist next run, attempt, query revision, pagination progress and source generation. Pausing/disconnecting cancels in-flight requests and invalidates their generation before commit. Skip missed timer ticks after sleep. On SIGTERM or control stop, stop timers, abort network work, finish or roll back the active transaction, close streams, checkpoint and release the lock.
- Use a 20-second timeout for ordinary reads, separate stream heartbeat detection, and exponential backoff with jitter from 30 seconds up to 30 minutes for network/5xx errors. For 429 wait until the latest applicable reset or Retry-After plus small jitter. On 401 or an account verification response, wait for account action. On 403 stop the affected collector. Record a safe status code and next retry.

## Deterministic matching and scoring, version 1

Normalize a comparison copy with Unicode NFKC, case folding and collapsed whitespace. Preserve original text. Word and hashtag rules use Unicode token boundaries; keep # and @ prefixes meaningful. A phrase is a contiguous sequence of normalized tokens with the configured punctuation preserved. Use the same matcher in preview and ingestion. ANY requires at least one inclusion; ALL requires every inclusion. Any exclusion vetoes. Apply enabled state, mute, allowed account and BCP-47 language filters first. Resolve a configured handle against known source identity when possible. A required unknown attribute makes a candidate ineligible for that filter. Absent optional signals do not penalize ranking.

For a configured minimum engagement use the sum of known likes, reposts and replies. Pass if the known lower bound reaches the minimum. Otherwise retain an unresolved candidate briefly for a bounded recheck if any counter is missing. With a zero floor the gate is off. Collapse repost wrappers onto the referenced original for notification identity where supplied, while retaining the wrapper kind/author for matching. A quote is a separate post.

For each matched watchlist compute a weighted mean over **available** signals, then subtract explicit penalties and round once. Persist raw values, availability, weights, contributions, penalties, model version and settings revision. Clamp every component and the final 0–100 score. Settings require a positive keyword weight. Zero-weight signals do not participate.

| Signal | Weight | Value in [0,1] |
| --- | ---: | --- |
| Term relevance | 35 | 0.4 + 0.4 × fraction of included terms matched + 0.1 for a matched exact phrase + 0.1 for a matched important term, capped at 1 |
| Popularity | 20 | Mean over known counters of min(1, log(1+count)/log(1+reference)). References are 500 likes, 100 reposts, 100 replies and 50,000 views |
| Velocity | 15 | For common counters on two snapshots at least five minutes apart, sum positive hourly growth of likes + 2×reposts + replies, then min(1, log(1+growth)/log(101)). Drop reset/decreasing counters from the pair. With only one snapshot, use the same available weighted counts divided by max(age in hours, 0.5), labeled an age-based estimate |
| Follows author | 10 | 1 for confirmed following, 0 for confirmed non-following, omit when unknown or stale |
| Prior liked author | 5 | 1 for a recent confirmed positive signal, otherwise omit when history is partial |
| Favorite account | 10 | 1 when marked globally or by the list. An unmarked author has no favorite signal |
| Local feedback | 5 | Across this author's retained rated posts count each useful or favorited post once, and let a negative rating supersede a favorite on the same post. With more positive votes use 1, with more negative votes use 0, and omit a tie. This makes the first Useful vote a boost or a tie at the maximum score |

If age or relevant counters are unknown, omit the corresponding velocity estimate. v1 promotional penalty is 10 for a post with at least three distinct outbound links. Repeated normalized text by the same author under another ID within 24 hours costs 15, with a total penalty ceiling of 25. Use a hash of normalized text for this check. The same ID arriving twice is an upsert and incurs no penalty. Do not infer author traits. Show the measurable reason, e.g. “Three outbound links (−10).”

**Worked example.** A post matches both terms, including one phrase and one important term. Relevance is 1. Popularity is 0.5, and a favorite-account signal is 1. All other signals are unavailable. The unpenalized score is round(100 × (35 + 10 + 10) / 65) = 85. With the 10-point link penalty it is 75. A fixture with only a plain term fully matched scores 80, which illustrates why an unknown signal must be distinguished from a measured zero.

## Notification decisions

1. Classify per list after scoring. Defaults are 70 standard, 85 immediate, below 70 silent. Require standard ≤ immediate. Immediate is eligible for dispatch now. Standard is coalesced per post in a 60-second evaluation window, allowing later overlapping matches to join. A pending standard can upgrade to immediate. Rechecks upgrade a previously silent post to delayed-popularity when it crosses a threshold.
2. Recheck previously silent posts within 10 points of standard, or unresolved engagement-floor candidates. Require source lookup capability, age below six hours. At most two rechecks per post, due at +15 and +60 minutes from initial collection, coalesced into batches of up to 25 IDs. Use the same ranker and persist comparison snapshots. Content freshness checks have a separate purpose and do not generate retroactive alerts.
3. Evaluate pause, quiet hours (configured IANA zone, local wall time, half-open interval spanning midnight), global daily cap (default 20 per local calendar day) and per-list cooldown (default five minutes). Apply controls to every priority. Re-evaluate at dispatch. Select the highest eligible priority across lists, breaking ties by score then stable list ID. Charge one daily slot and the winning list cooldown. If every list is blocked, retain the feed reason and suppress the alert. Quiet hours create no morning backlog.
4. Use a unique canonical notification key and one transaction for history plus dispatch state. Keep a single durable history entry. Reserve the daily notification slot and mark dispatch started before invoking the OS. A crash after dispatch starts has ambiguous delivery. Mark it unknown on recovery and do not replay it. Retry only a confirmed pre-submission transient failure within its short freshness window. Prefer a missed toast to duplicate interruptions. Desktop permission failure still leaves an unread local notification. Read state is separate from delivery state.
5. Native adapter in the source build uses node-notifier in the interactive desktop session. Check notifier availability and click support at startup and via a test notification. Linux requires a desktop notification service and actions depend on the server. Windows registration and macOS sender identity affect activation. The packaged adapter uses Electron main-process Notification, install-time registration and a signed identity. Route every supported click through the stored ID to an allowlisted original X URL, marking the entry read. A simulated click opens local detail. When actions are unavailable the center retains a working Open original action. Do not expose tweet text on the lock screen by default. [Node notifier](https://github.com/mikaelbr/node-notifier) · [Electron notification requirements](https://www.electronjs.org/docs/latest/tutorial/notifications)

## Local trust boundary

Assume the current OS user controls their profile. Protect against unrelated websites, other OS users, accidental logging and unexpected input. Use user-only ACLs/modes for control channel, database and runtime files. Validate the exact HTTP Host including port and reject foreign Origin, wildcard CORS and cross-site mutations. Require a session for all private reads and event streams. The launcher sends a random short-lived, single-use nonce in a URL fragment. The UI exchanges it via a same-origin JSON POST, removes the fragment and receives an HttpOnly SameSite=Strict host-only session cookie plus a per-session CSRF token for writes. Expire sessions after bounded inactivity and rotate on service restart. Scope cookie and sessions to this service, validate CSRF and exact origin, never pass session IDs in event URLs. HTTP loopback cookies share host scope across ports; keep X credentials independent of browser sessions.

The sandboxed X window uses a dedicated Electron browser partition and shares only status with the worker. Automated collection requires its own authorized interface. Hosted client tokens use a masked terminal prompt and the OS vault. SQLite stores safe diagnostics and a vault reference. Disconnect clears browser data or the relevant hosted credential. [Electron session](https://www.electronjs.org/docs/latest/api/session) · [Keyring binding](https://github.com/Brooooooklyn/keyring-node)

Use parameterized SQL, shared validators with size limits, safe text rendering, restrictive same-origin CSP and allowlisted HTTPS X permalink construction from validated IDs. No arbitrary URL fetch/open API. Initials are the offline avatar fallback; any enabled real avatar fetch is restricted to verified X image hosts, with response-size, redirect and timeout limits. Protect destructive actions with an explicit local confirmation. Purge includes secrets, caches, snapshots, SQLite sidecars and runtime sessions. Keep logs free of tokens, post bodies, private signals, search terms and authentication URLs.

## Install and operate the source release

From the project directory, install the supported Node runtime, run npm ci and npm run build, then npm run monitor -- start and npm run monitor -- open. Implement monitor as the root script dispatching to the built service CLI. A second open issues a fresh UI session for the same worker. npm run monitor -- status prints a redacted health summary. To upgrade, stop the worker, install the next tagged source/lockfile, rebuild and start it to run migrations. To remove the source release, erase the profile through Settings if requested, stop the worker and remove the installation directory. Show the exact retained data path when keeping a profile. [Node release lifecycle](https://nodejs.org/en/about/previous-releases)

## Distribution decision

| Approach | Benefit | Cost and planned use |
| --- | --- | --- |
| Browser + Node CLI | Smallest mock proof. One runtime and an independently testable worker | Requires local runtime installation, explicit start and platform-specific notification checks. First development release |
| Tauri with Node sidecar | Uses system webview and can reduce shell footprint | Adds Rust tooling, a bundled sidecar per target and an IPC/lifecycle boundary. Reconsider if measured installer or memory targets rule out Electron. [Tauri sidecars](https://v2.tauri.app/develop/sidecar/) |
| Electron shell | Reuses JS skills, bundles runtime, owns tray, login settings, notifications and installer identity | Larger downloads and memory footprint, signing and native-module rebuilds. Selected for the installable desktop phase. Keep the render window destroyed while background-only |

For desktop, the tray host supervises exactly one service worker and relaunches it with capped backoff. Use isolated sandboxed renderer, no Node integration, same local API. Close hides/destroys the window; explicit Quit stops the worker. Register per-user startup only on opt-in (Windows login item, macOS login item, Linux XDG autostart). Target signed Windows installer, signed/notarized macOS app, and Linux distro packages. Test Windows notification shortcut identity and activation, macOS authorization/clicks and Linux desktop actions. Update Windows/macOS through signed releases, Linux through the package manager. Stop ingestion, close SQLite, verify the package and validate migration before resuming. Preserve settings across upgrades; if migration fails, restore a protected short-lived migration copy and run the compatible prior version. Uninstall unregisters login launch, tray/activation helpers and service. Offer explicit removal of retained user data and credentials. [Electron updates](https://www.electronjs.org/docs/latest/api/auto-updater)
