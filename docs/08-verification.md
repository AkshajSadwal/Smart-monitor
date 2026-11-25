# Implementation and verification

This is the initial release record. See the [current release verification](11-release-readiness.md) for session architecture results.

This record covers Windows x64, Node 24.18.0 and Chromium on the implementation host. The release targets also include macOS and graphical Linux. The simulated application runs without an X account.

| Roadmap milestone | Implementation and evidence |
| --- | --- |
| 1 · Local foundation | Next.js static export and same-origin Fastify API, detached launcher, authenticated bootstrap, local SQLite migrations. Chromium rendered the ported Three.js mascot and its reduced-motion fallback with WebGL disabled. Inspected the dashboard at desktop size and 320 px. |
| 2 · Watch a topic | Browser integration created and previewed the ALL watchlist, started collection with the browser closed, then reopened the dashboard and inspected its score. Unit tests cover Unicode rules, exclusions, exact phrases and unavailable signals. |
| 3 · Prove alert quality | Test clock reproduced 65 → 83 and one delayed alert. Verified immediate and standard decisions, quiet hours, daily limits, duplicate suppression, interrupted native dispatch recovery, retained state after restart, feedback and read state. |
| 4 · Authorized data | The initial live path was retired. [Current collection feasibility](03-collection.md) |
| 5 · Desktop experience | Built the unsigned Windows x64 NSIS installer. The unpacked Windows app passed dashboard startup, closed-window worker activity, tray-host reactivation, persisted alerts and clean quit. Electron reported the native test notification as submitted. The shell bundles a checksum-verified Node runtime for its SQLite worker. Signed updates require publisher identity and a configured update provider. |
| 6 · Release | Production build, strict TypeScript, ESLint, 10 service tests and two Chromium integration tests passed. The feed performance smoke test returned 30 rows from 10,000 in-memory synthetic posts and 20 watchlists at 8 ms p95 over 30 in-process requests. This measurement excludes network and browser rendering. The full one-hour CPU/RSS soak and native OS release matrix remain pending. |

## Remaining platform verification

- Verify install, login launch, lock-screen behavior, native toast clicks, update, uninstall and erasure on each supported desktop OS with a signed package and an interactive test account.
- Test macOS signing and notarization and Linux package installation on their native systems. The Windows host cannot validate those platform behaviors.
- Verify an approved session interface with a real search before accepting live collection. [Collection feasibility](03-collection.md)
- Compare the port with a running Word Survival scene if a side-by-side visual approval is required. The integration check confirmed the carried shader and a rendered procedural coat.

The standalone workflow and commands are in the [README](../README.md).
