# Implementation roadmap and release verification

Build milestones in dependency order. The first three produce a complete, reproducible local application. Live API access and signed desktop releases each have their own acceptance evidence. A simulated test can verify a connector contract; it cannot verify account entitlement or native delivery.

| Milestone | Depends on | Implement | Exit evidence |
| --- | --- | --- | --- |
| 1 · Local foundation | Empty project, read access to mascot source | Workspaces, strict TS, build and CLI, per-user runtime, migrations, authenticated same-origin UI, theme and ported mascot | Clean install/build opens through launcher. Second start reuses the worker. Copied model renders, falls back without WebGL and respects reduced motion. Source project has no required runtime dependency |
| 2 · Watch a topic | 1 | Seeded clock/collector, watchlist CRUD and preview, normalization, eligibility and scoring, persisted cursor, feed/detail, source health, dashboard and onboarding | Create an ALL watchlist, observe a qualifying post and a rejected exclusion, open an explanation, close/reopen tab, restart service and recover results |
| 3 · Prove alert quality | 2 | Rechecks, snapshot velocity, feedback/favorites/mutes, rule editing, delayed/standard/immediate decisions, cooldowns, quiet hours, cap, center, native notification adapter and settings | Repeated ID and overlapping lists yield one history row. Later growth crosses once. Source remains simulated everywhere. Closed-window native attempt and actual OS outcome recorded separately |
| 4 · Collection boundaries | 3; explicit authorization for live data | Manual X sign-in, shared session page validation, durable pagination, authenticated hosted subscriptions and replay | Fixtures exercise expired, restricted and rate-limited states. Live search requires an authorized provider and separate acceptance. |
| 5 · Desktop experience | Stable service protocol and notification decisions | Package the same UI/service in Electron, implement tray supervisor, native alerts and activation, per-user auto-start, update and removal | On each supported OS install fresh, enable startup, log in, close window, receive/click a test alert, pause from tray, quit, update from prior version and uninstall |
| 6 · Release | 1–5 for full distribution | Security review, migrations from previous releases, accessibility/visual QA, load and soak testing, platform instructions, redacted diagnostic export if needed for a specific issue | Release evidence lists tested OS/build, scenarios, measured usage, known limitations and any remaining blocked capabilities |

## Golden fixture

Fix the test clock to 2026-01-12 12:00 UTC. Use synthetic IDs and author names. Start with simulation, one list with the single plain term “SQLite”, no author preferences or account signals, thresholds 70/85, and quiet hours off. Fake time moves the backend scheduler; scheduled integration tests need no wall-clock waiting.

| Input | Expected outcome |
| --- | --- |
| P1, age 2 h, text “SQLite preview”, likes 20, other metrics absent | Relevance .8, popularity log(21)/log(501), initial hourly estimate 10. Score 65, feed only, eligible for recheck |
| P1 again on another page with the same observation identity | Same post and snapshot, no duplicate recheck |
| P1 at +15 min, likes 100 | Measured growth 320 likes/hour. Score 83. Exactly one delayed-popularity alert with old/new score and the triggering list |
| P2 from a different author, plain matching term, unknown metrics and creation time | Score 80 using the keyword signal alone, velocity unavailable. A standard alert after its window if allowed by cooldown |
| P3 with both terms in the example ALL watchlist, one phrase plus an important term, metrics unknown, different author | Score 100 for that list. One immediate alert when enabled and eligible; the same ID can match the original list |
| P4 text “SQLite release candidate hiring”, English, example ALL list excludes “hiring” | Excluded in that list; a second plain “SQLite” list can still match |
| P5 with the same author as P1, comparable observed inputs after P1 gets a Useful vote | Score at least as high as the no-feedback control and explanation includes local feedback. Repeating the vote leaves the score unchanged; muting the author excludes the next post |

Run cases in isolation when checking a specific score or delivery class. For the end-to-end timeline, schedule P2/P3 beyond the winning list cooldown or explicitly configure zero cooldown. Use another fixture with quiet hours and cap enabled to test suppression.

## Verification matrix

| Layer | Cases | Pass condition |
| --- | --- | --- |
| Matcher | Unicode case/normalization, word boundaries (“AI” vs “paid”), literal hashtags, exact contiguous phrases, ANY/ALL, exclusions, deleted/disabled lists, unknown language, account allowlist, partial engagement floor | Preview and ingestion agree for all fixtures, preserved source text is unchanged |
| Ranker | Worked 85/75 example, known zero vs unavailable, zero weights rejected for keyword, sign of feedback, negative deltas, out-of-order times, future/missing timestamps, capped age proxy, two snapshots, repeated text vs repeated ID | Deterministic integer 0–100. Explanations reconstruct the score. A missing snapshot does not masquerade as measured growth |
| Alert policy | Scores at 69/70/84/85, delayed crossing, ties across lists, quiet interval spanning midnight, DST jump/repetition, cap reset, cooldown, mute/disable during pending dispatch, recovery after ambiguous OS send | One durable alert per canonical identity; no retroactive interruption after quiet hours |
| Collectors/jobs | Partial pages, expired tokens, source generation switch, disconnect during fetch, timeout/5xx, 401/403, 429 reset, stream reconnect, burst of matching results and post tombstones | No skipped completed range, false success, leaked secret or premature retry. Gaps and unknown results are visible |
| SQLite | Empty and previously migrated profiles, live WAL backup, failure halfway through migration, interrupted page commit, expired lease, deletion of one list, retention and wipe with locked vault | Schema version and rows agree after restart; unrelated lists survive list deletion; incomplete erasure resumes safely |
| API/security | Invalid shapes and bounds, unknown host, foreign origin, CSRF/session failure, reused nonce, stale revisions, malformed cursors, oversized input, unavailable vault, invalid original URL | Correct status/codes; side effects absent on rejection. Redacted captures contain no token, cookie, or private post text |
| UI integration | Local Playwright with real Fastify, disposable DB and seeded collector, onboarding → watchlist → feed → explanation → feedback → notification → pause → restart | Normal user entry points work on desktop and narrow viewports. Refresh/deep link works; SSE reconnect repairs missing events |
| Resource use | On a recorded ordinary four-core/8 GB baseline, 10k retained synthetic posts and 20 lists, run 60 min including 15 min with UI closed | Initial engineering targets: p95 first 30 feed rows <250 ms locally, closed-view idle service CPU <1% of one core, idle RSS <150 MiB, no increasing handle count or overlapping polls. Report actual measurements and OS |
| Desktop release | Windows/macOS/Linux user sessions, notifications allowed/denied, Linux actions unavailable, service crash, suspend/resume, auto-launch off/on, update and uninstall | Evidence includes versions, actual toast/click results, grace after failures and data preservation/removal choice. Record headless or unsupported combinations |

## Deliverables at each release

Commit reproducible npm scripts for dev, build, typecheck, lint, test and test:e2e plus documented service CLI commands. Use temporary profiles for integration tests and injected clocks, vaults, HTTP transports and notifiers. Include a user guide covering simulation, authorized source setup, data location, source reset, starting/stopping and troubleshooting. Ship a versioned migration set, fixture provenance, actual verification results and install/update instructions appropriate to the milestone. Keep live acceptance explicit and signing material outside the repository.
