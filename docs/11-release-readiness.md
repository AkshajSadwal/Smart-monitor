# Session architecture release readiness

## Implementation

- **Local X Account.** The desktop opens a sandboxed window on X for manual sign-in and account verification. A separate browser partition keeps sign-in state on the device. Opted-in persistence requires an available OS-backed storage mechanism. The worker receives only status and persistence metadata. The window detects a first-party sign-in cookie and can clear its partition. Smart Monitor has no approved interface for verifying the username or running live search. Manual sharing of a selected permalink and excerpt remains available.
- **Authorized session collector.** The fixture boundary stores opaque grants via the OS vault interface, validates bounded pages using the common post schema, and commits post data with its cursor. It holds on expired, denied or verification-required sessions. It respects provider retry deadlines and keeps the cursor across transient failure and same-account reconnect. Search results follow the ordinary matching, ranking, SQLite and notification path.
- **Hosted Monitoring.** The bundled VM can start disabled or with simulated data. Public topics are approved on the desktop and aggregated on the VM. Authenticated delivery, per-client replay and lease, expiry and revocation behavior remain in place. A desktop client checks a server's reported provider before publishing topics. The VM retains field-level publication and deletion guards for authorized provider fixtures. The VM never receives the user's X session.
- **Shared behavior.** Session pages and hosted frames use the same post validator. Topic normalization and source deactivation each have one implementation. Canonical IDs merge newly observed edit variants and keep alert decisions unique. Existing matching, ranking, rechecks, notification rules, watchlists, feedback, favorites, mascot and desktop tray remain the normal pipeline.
- **Retirement.** The developer API-key collector, paid budgets, stream, polling lookup, hydration, OAuth routes and VM API provider were removed. There are no removed or added npm dependencies. The OS vault binding remains for hosted tokens and explicit legacy cleanup. Runtime routes and distribution use the same existing Fastify and Electron architecture.

## Profile compatibility

Migrations 1–4 retain their original checksums. Schema 5 pauses profiles using a retired collector and makes Simulated the selected test source. It retires incompatible scheduled jobs and API-only preferences. Historical provenance, scores, user settings, watchlists and notifications remain available. The Feed and Notifications source filters include **Earlier X collection**. Existing browser-profile or vault credentials are left alone during migration.

A private copy created by the previous implementation passed the schema-4-to-5 upgrade and SQLite integrity and foreign-key checks. The historical feed and notification endpoints returned the preserved post and alert. The watchlist, author, score, feedback, favorite preference and unrelated alert cap survived. The original test database hash was unchanged.

Use `npm run monitor -- cleanup-retired-credentials --confirm` for old desktop vault entries. Use `npm run hosted -- cleanup-retired-credentials --confirm` against the intended hosted database for old encrypted operator credentials. Both commands require an explicit operator action. The hosted cleanup was tested against a legacy table and preserved an unrelated secret row and the issued client token.

## Verification on Windows x64

| Check | Result |
| --- | --- |
| `npm ci` and `npm audit --audit-level=moderate` | Passed. Zero advisories reported. |
| `npm run typecheck`, `npm run lint`, `npm test` | Passed. 23 tests, including real loopback clients, authorization boundaries, fixture ranking and notification dispatch, and SQLite upgrade. |
| `npm run build`, `npm run build:hosted`, `npm run test:hosted` | Passed. The bundled server issued a test client token and delivered simulated SSE. An unsupported live configuration exited before opening a listener. |
| `docker compose -f services/hosted-collector/compose.yaml config --quiet` | Passed locally. |
| `npm run test:e2e` | Three Chromium tests passed. |
| `npm run test:desktop:dev` | Passed. An intercepted first-party fixture proved sign-in detection, persistence across a full Electron restart and disconnect. The Electron native test reported submitted. |
| `npm run desktop:package -- --win --x64 --publish never` | Passed. The unsigned installer is under `release/session/`, alongside the unpacked application. The previous release files were preserved. |
| `npm run test:desktop:win` | Passed against `release/session/win-unpacked`. The worker SHA-256 matched the final bundle. The fixture verified sign-in detection, Windows restart persistence, and disconnect. Background monitoring, history, activation and shutdown passed. Electron reported the native test as submitted. |
| `npm run test:performance` | Passed with 10,000 synthetic posts and 20 watchlists in in-memory SQLite on Windows x64 build 10.0.26300, Node 24.18.0, Intel Core 7 240H, 16 logical CPUs and about 16 GiB RAM. Feed p95 was 26 ms, scoring 287,584 evaluations/sec, ingestion 497 posts/sec, indexed query mean 0.008 ms, and 25 notification decisions 13.12 ms. Peak RSS was 377 MiB, with CPU use about one logical core. The two-client test separately replayed two retained events in 22 ms on this host. |

The signature and filename scans found no matching private keys, common token signatures, private SQLite files or browser sessions in tracked files. The produced worker and hosted bundles contained no retired X developer API endpoints or OAuth routes.

## External gates

- **Local live search and account signals are unsupported.** Live acceptance needs an expressly authorized X interface, a real search result, and separate checks for lookup and private relationship signals. Browser-cookie import has no authorized setup path. A real X sign-in and MFA were outside the fixture run.
- **Hosted live collection is unavailable in the bundled server.** Live acceptance needs an authorized operator source, permission for the exact fields and recipients, a public HTTPS VM and two separately authenticated profiles. Simulation works locally.
- Confirm visible OS notifications and click behavior on an interactive desktop. The Electron result confirms OS submission. Native Linux and macOS acceptance and signed installation are pending for this revision.

[Manual acceptance](10-manual-testing.md) · [X policy](12-content-compliance.md)

## Changed files

### Added

- `apps/desktop/account.cjs`
- `apps/service/credential-store.ts`
- `tests/session.test.ts`

### Modified

- `.dockerignore`
- `.gitignore`
- `README.md`
- `apps/desktop/main.cjs`
- `apps/desktop/package.json`
- `apps/service/api.ts`
- `apps/service/cli.ts`
- `apps/service/desktop-ipc.ts`
- `apps/service/hosted-client.ts`
- `apps/service/monitor.ts`
- `apps/service/storage.ts`
- `apps/service/website-session.ts`
- `apps/web/components/client.ts`
- `apps/web/components/preferences.tsx`
- `apps/web/components/workspace.tsx`
- `docs/01-product.md`
- `docs/02-architecture.md`
- `docs/03-collection.md`
- `docs/04-interface.md`
- `docs/05-data-api.md`
- `docs/06-roadmap.md`
- `docs/08-verification.md`
- `docs/09-multi-source.md`
- `docs/10-manual-testing.md`
- `docs/11-release-readiness.md`
- `docs/12-content-compliance.md`
- `packages/collection-core/collector.ts`
- `packages/collection-core/hosted.ts`
- `packages/contracts/index.ts`
- `scripts/package-desktop.mjs`
- `services/hosted-collector/compose.yaml`
- `services/hosted-collector/src/main.ts`
- `services/hosted-collector/src/provider.ts`
- `services/hosted-collector/src/publication.ts`
- `services/hosted-collector/src/service.ts`
- `tests/browser/monitor.spec.ts`
- `tests/completion.test.ts`
- `tests/core.test.ts`
- `tests/desktop-smoke.ts`
- `tests/multi-source.test.ts`
- `tests/release.test.ts`

### Removed

- `apps/service/x-api.ts`
- `docs/07-sol-handoff.md`
- `packages/collection-core/x-protocol.ts`
- `tests/x-api.test.ts`
