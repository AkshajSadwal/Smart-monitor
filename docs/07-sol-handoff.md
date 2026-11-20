# Implementation prompt for Sol 6.2 (High)

Use the following prompt in a coding session with access to the project folder and the Word Survival mascot source.

---

Build **X Smart Monitor** in `A:\srcaper` from the planning documents already present. Deliver a local-first personal topic monitor for Windows, macOS and Linux. Someone should be able to start with zero X credentials, create a watchlist, close the browser, return to a ranked feed, understand one alert and improve future ranking with feedback.

## Read first

1. [Product requirements](01-product.md) defines the user flows, scope, defaults and owner decisions.
2. [Architecture](02-architecture.md) defines service ownership, matching/scoring formulas, notification policy, trust boundaries and distribution.
3. [Collection feasibility](03-collection.md) defines approved sources, budget controls, capability discovery, X policy concerns and live verification.
4. [UI specification](04-interface.md) defines screens, wording, states, accessible layout and the inspected mascot copy manifest.
5. [Database and API](05-data-api.md) defines persistence, migration order, routes, event names, validation and transaction boundaries.
6. [Roadmap](06-roadmap.md) defines milestone exits, golden fixtures and platform acceptance.

Treat the numeric fixtures as executable requirements. Keep a short implementation decision record when a documented assumption fails on a target platform. Keep progress on independent milestones moving when external account access or signing is unavailable.

## Set up the repository

Use npm workspaces with apps/web, apps/service, packages/contracts, config, fixtures, tests and docs. Add apps/desktop in the distribution milestone. Use strict TypeScript; lock dependencies. Select compatible Next.js App Router, React, Tailwind, Fastify and better-sqlite3 versions for Node 24 LTS. Use Zod schemas shared at the local API boundary. Put deterministic matching and scoring in service modules usable directly by tests. Keep source-specific networking, OS notifications and credentials behind small adapters. A local database in the OS user profile is the application store.

The installed web UI uses fixed, statically exported Next routes and same-origin REST plus authenticated SSE. Fastify owns scheduling and serves the export. Provide one normal CLI launcher flow for real users and use it in a production-build smoke test. During development either serve a rebuilt static export or proxy API/events through the local dev server with explicit trusted development origins. Ship the production host/origin checks enabled.

## Build in this order

1. **Foundation and identity.** Set up scripts, shared schemas, temp-profile tests and transactional migrations. Implement service start/open/status/stop, session bootstrap and a minimal health page. In the frontend, port the original model, controller, portrait store, scene, wrapper, reduced-motion hook and scoped styles from the manifest. Anchor visual parity on three@0.183.2. Preserve generated fur, eyes, lighting, blink, gaze, idle variants, success cue and CSS fallback. Inspect original files read-only and copy only the identified pieces into the new tree.
2. **First vertical slice.** Create a watchlist through onboarding, poll the seeded mock collector using a fakeable clock, normalize and filter posts, score and persist matches, publish after commit and render one explained feed result. Confirm polling continues with all tabs closed. Build dashboard, watchlist editor, ranked feed/detail, source screen and settings against the real local API. Use a prominent Simulated label on feed, detail, dashboard and notifications. Synthetic posts open local detail.
3. **Attention controls.** Implement feedback, favorites, muted authors, comparison snapshots, eligible rechecks, per-list thresholds and cooldown, quiet hours with timezone, daily cap and pause. Enforce canonical deduplication in SQLite and reserve native delivery transactionally. Ship the notification center, read state and a backend-driven notification adapter with capability diagnostics and a test action. Make unavailable metrics explicit. Finish and verify the golden fixture, browser integration, durable restart and closed-tab flow before enabling real collection.
4. **Official polling.** Start with an injectable read-only HTTP adapter and synthetic provider responses. Use the owner's app-only bearer from the OS vault, an explicit budget and recent search. Compile supported upstream queries and apply authoritative filters locally. Persist pagination before advancing watermarks. Record gaps after sleep, account denial and excluded time ranges. Implement rate reset handling, credit exhaustion, cancellation, purge and freshness. Expose authenticated user PKCE only for explicitly selected capabilities. Follows and liked-author signals can be unknown independently. A source disconnect clears account bindings and secrets. Check supported search, lookup, required display fields and billing using the owner's authorized test budget when available.
5. **Optional official streaming.** Implement filtered stream and installation-owned rules when entitlement is available. Include reconnect, burst controls, cancellation, gap reporting and a budgeted backfill. Label the selected transport accurately. Omit unsupported options from selectable actions and explain restrictions in Data Sources. Keep external operations read-only with the single exception of configuring the app's official stream rules. Never script X's website, collect account passwords or import browser sessions.
6. **Desktop and release.** Wrap the same UI and worker in Electron, keeping a per-user tray host active on window close. Make Quit and startup behavior explicit. Install/register an identifiable notification sender, wire permitted clicks to a validated original permalink, and verify behavior when permissions are denied. Build and test platform artifacts on their native systems. Use the desktop roadmap for signed distribution, update, migration recovery, uninstall and data erasure. Develop packaging definitions independently of the availability of publisher credentials.

## Guard the product invariants

- Separate “matched”, “scored”, “eligible to notify”, “stored notification”, “attempted native delivery” and “read”. Explain each relevant decision to the user.
- Keep the UI out of the scheduling loop. Upstream input is untrusted, including author names, post links, counters and pagination tokens. Honor known absences and nulls. A failed network operation is not evidence that a user unfollowed an author.
- A matching original may appear in more than one list. Persist distinct list explanations and a single canonical notification. An inflight request from a removed source or edited rule cannot commit stale results. Retry after a partial page safely.
- Preserve exclusions, required filters and mute even when a post is popular. Use actual available weights and a reason snapshot. Show age-derived velocity and measured change separately. Do not let accumulated duplicates produce extra alerts.
- Pause and quiet hours take precedence over priority. A restart cannot redeliver an ambiguous native send. The in-app center must work when the OS notification service is missing.
- Keep API tokens, session cookies and OAuth verifiers out of frontend state and logs, except the browser's own HttpOnly **local** session cookie. Prefer masked CLI input or the system OAuth flow. No cloud services are required for simulation.
- Validate source eligibility before displaying cached live text. Use local match summaries with a safe original link where an attributed live post cannot be rendered. Provide disconnect, pause and local erase as working controls.

## Validation and handback

Run typecheck, lint, unit and DB tests, production build, service lifecycle test and Playwright integration against a disposable profile. Include the exact commands in the README. Verify matching, scores 65→83, notification thresholds, rate-limit recovery, migrations, API validation and UI/backend integration from the roadmap. Test stale sessions, rejected foreign origins, concurrent list edits, replayed post IDs and dispatch interruption. Inspect the rendered glass UI at 320 px and desktop width, keyboard-only navigation, reduced motion and forced WebGL fallback.

Deliver source, lockfile, scripts, migrations, synthetic fixtures, tests, setup/operations instructions, user-facing documentation and the appropriate platform packaging files. Report measured results, actual host platforms, and the specific live or OS checks still pending with the reason. Paid calls require an owner-selected budget. Public signing requires the publisher's identity. Neither is required to deliver the working local simulation.
