# Release readiness

## Initial audit

The existing architecture and profile remain the starting point. Official app-only collection already supports bounded recent search, lookup, persisted cursors and optional stream access. OAuth already uses PKCE and the OS vault, with incremental relationship sync. Local website automation has a fixture-tested interface and requires authorization. Hosted SSE already shares normalized topics and persists events. Ranking, alert decisions and SQLite remain local.

This pass focuses on monetary spending limits and diagnostic probes, authorized hydration of ID-only events, explicit publication policies, hosted replay and credential expiry, desktop notification controls, and repeatable packaging across supported platforms.

Live X, provider billing, redistribution approval, a public VM, and interactive platform acceptance require separate verification. Automated fixtures do not contact X.

## Implementation

| Area | What changed | Why |
|---|---|---|
| Official X | Connection checks normalize one recent search, save a probe checkpoint, and distinguish missing, invalid, denied, rate-limited, out-of-budget, network, and invalid-response states. | A connectivity label alone does not verify auth, entitlement, or a usable payload. |
| Spending | Daily request, resource, and USD reservations are checked atomically before reads. Unknown or zero rates or ceilings block dispatch. The estimate uses the operator's verified maximum resource price. Streaming has its own provider-hard-cap attestation. | A request count alone cannot bound credit charges. |
| OAuth | Codes are single-use, a rejected code has a specific safe result, a renewable credential can refresh once on an ordinary 401, and rejected refresh clears relationship state. Account changes commit with updated vault state. | A failed or changed grant must not leave a previous account's signals active. |
| Hosted | Two authenticated clients share equivalent topics. Event replay accepts Last-Event-ID, scopes expiry gaps to owned topics, renews connected leases, and distinguishes token expiry, denial and terms acknowledgement. The socket write buffer stays bounded. | Recovery must preserve multi-client ownership while avoiding duplicate delivery side effects. |
| Content | Disabled, simulated, IDs, metadata and full-object modes apply before persisting and serving events. Richer live modes require a distinct operator attestation, shorter replay and a shared publication quota. Confirmed removals purge caches. | The frontend cannot enforce the upstream license boundary. |
| Hydration and display | A bounded, opt-in local lookup can resolve hosted IDs without switching sources or sending credentials to the VM. Stale metadata is hidden. Optional official widgets are sandboxed and loaded after consent. | An identifier alone cannot establish keyword relevance or justify a notification. |
| Notifications | Simulated desktop toasts require separate opt-in. Settings tests the actual desktop path and reports OS submission or unavailability. Notification clicks resolve to the local detail or original X link. | A test must distinguish the dispatch invocation from a banner the user can see. |
| Release | Native Windows, both macOS architectures and Linux targets use Node 24 and rebuild SQLite for the packaged host. The GitHub Actions matrix is configured to check each target and attach packages to its run. | The native runtime and vault dependencies require platform-specific verification. |

Use [manual tests A–H](10-manual-testing.md) and the [content policy](12-content-compliance.md) for acceptance and authorization requirements.

## Security and profile review

- X credentials and VM client tokens remain in the OS vault. The VM independently encrypts the operator credential and stores only hashes of client tokens. Admin commands use the private worker environment or database. Public health and subscription status expose no administrator credential.
- The desktop renderer has context isolation and sandboxing. Worker IPC bounds notice payloads and validates external post links. Fastify binds to loopback, validates Host and Origin, requires a local HttpOnly session and CSRF on writes, and separates privileged control calls. Hosted HTTPS pins an approved public DNS address, refuses redirects, and keeps normal certificate validation.
- Live calls are outside ordinary tests. Their credentials come from the selected profile. The one-page X or OAuth probe requires a paused worker, two explicit flags, and a positive configured local budget. The VM acceptance probe is simulation-only and authenticates with a saved token.
- Existing local schema 4, watchlists, collected posts, feedback, notification history, checkpoints, and credentials were preserved. Defaults for new preferences are read over the stored settings. Hosted tables are additive. A failed local schema upgrade retains its pre-migration backup.
- The clean dependency audit flagged the old static-serving and notification packages and the Electron build chain. The lockfile upgrades the affected versions and scopes tooling overrides to the affected packages. The local tracked-file scan covered secret file extensions and common key and token signatures. It does not substitute for a full organizational credential inventory.
- The public policy review verified that redistribution mode, widget display, storage, and removal each have distinct requirements. The implemented purge commands do not automatically propagate a takedown to disconnected devices or backup archives. Those copies need an operator process.

## Verification

| Check | Result |
|---|---|
| `npm ci` | Passed on Windows and in Ubuntu 24.04 under WSL2 from the patched lockfile. |
| `npm audit` and `npm audit --omit=dev` | Passed with zero reported advisories. The staged Windows and Linux AppImage production dependency trees also reported zero. |
| `npm run typecheck` and `npm run lint` | Passed on Windows and Linux. |
| `npm test` | 34 passed on Windows and 34 passed on Linux. Includes both official fixtures through notification dispatch, verified website-session fixtures, and real loopback SSE across two clients, restart, expiry and revocation. |
| `npm run build` and `npm run build:hosted` | Passed on Windows and Linux. |
| `npm run test:hosted` | Passed on Windows and Linux. The final image, built from the hosted Dockerfile with Podman on B:, passed a two-client simulated SSE check in a network-isolated container. |
| `npm run test:e2e` | Three Chromium tests passed on Windows and three on Linux. X widget JavaScript was intercepted by a fixture after explicit consent. |
| `npm run test:desktop:dev` | Passed on Windows x64. Electron reported the test notification as submitted. |
| `npm run desktop:package -- --win --x64 --publish never` and `npm run test:desktop:win` | Passed. The unsigned NSIS installer was rebuilt. The unpacked app passed background polling, history, tray activation and clean shutdown. Its worker hash matched the final bundle. Electron reported the test notification as submitted. |
| `npm run desktop:package -- --linux appimage --x64 --publish never` and `npm run desktop:package -- --linux deb rpm --x64 --publish never` | Linux x64 AppImage, DEB and RPM built on Ubuntu 24.04 under WSL2. The isolated WSL filesystem on B: provided build space after the Windows system drive filled. The worker extracted from each package matched the final build. The DEB reported `amd64` and the RPM reported `x86_64`. |
| `npm run test:desktop` with the Linux unpacked executable under D-Bus and Xvfb | Passed startup, dashboard, background monitoring, notification history, activation and shutdown. Native notification status was `unavailable` in the headless session. |
| Native Intel and Apple Silicon macOS packaging and smoke | Not run. The workflow is configured for both architectures. |
| Docker Compose and Caddy configuration | Validated locally. Public DNS, certificate issuance, and public proxy behavior remain external. |
| GitHub Actions | Workflow parsed locally. Native Windows, Linux, Intel macOS and Apple Silicon jobs are configured. GitHub-hosted runs are pending. |
| `verify-x` and `verify-oauth` | Fresh profile reported `NOT TESTED — CREDENTIALS REQUIRED`. No live connectivity was inferred. |
| `verify-hosted` | The invocation without opt-in returned `NOT TESTED — EXPLICIT VM OPT-IN REQUIRED`. The external HTTPS probe was not run. |

The local Windows artifact is `release/Smart Monitor Setup 0.1.0.exe`. The Linux artifacts and their verified `SHA256SUMS-linux.txt` are in `release/linux-final/`. These local build outputs are ignored by Git.

## Performance

The final in-process run used Windows x64 build 10.0.26300, Node 24.18.0, Intel Core 7 240H, 16 logical CPUs, and 16 GiB RAM. The database was in-memory SQLite with 10,000 synthetic posts and 20 watchlists. Packaging was also running on the host.

| Measurement | Result |
|---|---:|
| Feed p95 over 30 requests | 68 ms |
| Pure score evaluations | 67,536 per second |
| Ingest and rank against 20 lists | 130 posts per second |
| Indexed SQLite top-score query, mean of 1,000 | 0.033 ms |
| Notification decisions for 25 jobs, excluding OS delivery | 27 ms |
| Replay two retained SSE events after server reopen | 20 ms on Windows loopback |
| Benchmark process peak RSS | 373 MiB |
| Benchmark process CPU, relative to one logical core | 94% |

The initial benchmark showed repeated watchlist loading in each notification decision. The decision batch now reuses the watchlists already read for the monitoring cycle. These are workload-specific values and exclude real X, public network, desktop rendering, and long-run performance.

## External acceptance and release gates

- Run permitted real recent search, lookup, OAuth grant and revoke, optional signal sync, and Filtered Stream when separately entitled. Test the provider's actual credits and budget enforcement in the X Developer Console.
- Verify the operator license for the actual endpoint, display, fields, audience, cache and deletion procedure. Approve metadata, full-object delivery, and official widgets separately. Verify takedown propagation to receiving installations and backups.
- Configure the public VM and TLS domain, issue per-installation tokens, then run manual Test E with two profiles. Keep website-session networking disabled unless X expressly approves a supported integration.
- Accept the unsigned Windows test package locally and confirm actual toasts and clicks. Run both macOS builds and their GUI and Keychain acceptance on native hosts. Run Linux desktop visibility, login-launch, tray, and Secret Service checks in a user session. Sign and notarize release artifacts as appropriate before public distribution.

## Changed files

**Added**  
`.github/workflows/verify.yml`, `docs/11-release-readiness.md`, `docs/12-content-compliance.md`, `services/hosted-collector/src/publication.ts`, `tests/hosted-multi.test.ts`, `tests/release.test.ts`.

**Modified**  
`README.md`, `package.json`, `package-lock.json`, `docs/09-multi-source.md`, `docs/10-manual-testing.md`.

`apps/desktop/main.cjs`, `apps/desktop/package.json`, `apps/service/api.ts`, `apps/service/cli.ts`, `apps/service/hosted-client.ts`, `apps/service/monitor.ts`, `apps/service/storage.ts`, `apps/service/x-api.ts`, `apps/web/components/preferences.tsx`, `apps/web/components/workspace.tsx`.

`packages/collection-core/collector.ts`, `packages/collection-core/hosted.ts`, `packages/contracts/index.ts`, `services/hosted-collector/compose.yaml`, `services/hosted-collector/src/main.ts`, `services/hosted-collector/src/service.ts`.

`tests/browser/monitor.spec.ts`, `tests/completion.test.ts`, `tests/desktop-smoke.ts`, `tests/multi-source.test.ts`, `tests/performance.ts`, `tests/x-api.test.ts`.

**Removed**  
No tracked files were removed in this release pass.
