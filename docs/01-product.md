# X Smart Monitor · Product requirements

**Planning baseline · 20 November 2026**  
One person, one local OS profile, one monitor. The product helps someone following a topic decide which posts deserve attention and understand why they were alerted. A successful session can end with the browser closed.

## Planning package

| Document | Use it for |
| --- | --- |
| [Technical architecture](02-architecture.md) | Process ownership, ranking, security, notifications and distribution |
| [Collection feasibility](03-collection.md) | Session authorization and capabilities |
| [UI/UX specification](04-interface.md) | Screen behavior, glass theme, accessibility and inspected mascot manifest |
| [Database and local API](05-data-api.md) | Entities, transactions, requests, errors and events |
| [Implementation roadmap](06-roadmap.md) | Milestones, fixtures, acceptance tests and release gates |
| [Manual testing](10-manual-testing.md) | Desktop sign-in, local import and simulation |

## Users and smallest useful release

A developer might watch “SQLite” and “release” but exclude job postings. A researcher might track an exact phrase, prioritize two authors, and silence alerts overnight. Both need the matching feed even on days when no post merits an interruption.

The first demonstrable product is the complete **simulated monitoring loop**. From a clean install, choose Simulated, create a watchlist, start monitoring, close the tab, and reopen it after a scheduled cycle. See a silent match, an explained alert and a post that crossed its threshold on recheck. Mark one result Useful and observe the effect on a later result. Restart the service and recover history without repeating an alert. This proves the product without an X account or API spend. A live release adds authorized collection and separate platform verification.

## User journeys and observable requirements

| Journey | Product behavior | Acceptance observation |
| --- | --- | --- |
| First run | Explain simulated versus live, show where data lives, accept or edit a starter watchlist, preview a fixture and start explicitly | No live collection on install. The first match identifies its source, rule and time |
| Manage topics | Create, rename, duplicate by creating from the editor, pause, resume and delete a watchlist. Include words, hashtags, phrases, ANY/ALL, exclusions, authors, language, favorites, engagement floor and alert rules | Editing affects future collection. Deleting one list preserves posts and other lists' matches and alert history |
| Follow activity | Search retained post text and handles, filter by source, list, kind or priority, sort by time or score, inspect reasons, open original when available | One feed item per source post, all matching list names available, unknown metrics labeled |
| Train preferences | Useful and Not relevant change future author affinity. Favorite bookmarks a local post and contributes to affinity. Mute author excludes future matches and alerts. Settings can undo a mute or favorite an account | Changes take effect on the following decision. Historical notification explains its original score |
| Receive selectively | Each list has standard and immediate thresholds and a cooldown. Priority can rise on a selective recheck. Pause, quiet hours and a daily cap govern interruptions | One original alert per canonical post across lists, even after process restart. A suppressed match remains inspectable |
| Operate unattended | Show source, collection method, last success, next attempt, rate and authorization status and service state. Closing the tab leaves collection running while its local process and user session are active | Restart after sleep or loss of network without a burst of catch-up alerts |
| Control private data | Inspect enabled account signals, disable them, disconnect credentials, change retention, or erase local data | Disconnect stops live work and clears account-derived signals. Erasure includes history, settings and stored secrets |

## Decisions and their release boundary

| Planning question | Decision |
| --- | --- |
| 1. Browser or wrapper for MVP? | Local browser, same-origin static Next.js UI served by Fastify |
| 2. Who runs after tab close? | A separately launched per-user Node service. The scheduler has no browser dependency |
| 3. Safest live data path? | Local X collection requires an approved session interface. Simulated is the default test source |
| 4. Near-real-time? | Show local collection state and its last successful check |
| 5. Personal signals? | Local favorites, mutes and feedback always work. Own follows and own liked-post authors require available API data and explicit opt-in. Unknown stays unknown |
| 6. Without an authorized collection interface? | Entire simulated flow, including native alert attempts, scoring, rechecks, history, feedback and settings |
| 7. Desktop notifications? | Backend dispatch to a native adapter from a logged-in desktop session. Durable in-app history covers denied permissions, unavailable OS actions and delivery uncertainty |
| 8. Distribution? | Source installation and local CLI for MVP. Signed per-user desktop distribution, tray, login launch and updates in the desktop phase |
| 9. Mascot? | Port the existing procedural body, coat, controller, scene, portrait store, reduced-motion hook and scoped styles. The exact copy list is in the UI specification |
| 10. Smallest proof? | One active simulated source, one custom watchlist, scheduled ingestion, explainable ranking, silent and alert outcomes, feedback and restart persistence |

## Operating targets

Local storage, loopback networking, read-only X access and an independently running scheduler are release requirements. All basic workflows and automated tests run offline against seeded data after dependencies are installed. Use an accessible dark interface, keyboard-complete forms, locally bundled typography, reduced motion, bounded queries and bounded retention. Portability covers Windows, macOS and a graphical Linux session. A machine that is asleep, powered down or logged out can have collection gaps.

## Facts, assumptions, risks and owner choices

- **Confirmed.** The workspace was empty at inspection. The reference character is generated by Three.js and has a non-WebGL fallback. X publishes recent-search, stream, authentication and usage documentation. The collection assessment links the relevant sources.
- **Working assumptions.** Single-user installation and one active source at a time. English interface initially, Unicode watch terms and language filters from day one. Proposed thresholds, weights and retention are editable product defaults.
- **Risks.** Search coverage and cost vary with topic volume. Stream disconnects create gaps. A desktop OS may suppress a toast. A disconnected client can retain stale X content. The architecture and roadmap give a recovery or release test for each.
- **Owner input for live access.** Confirm the allowed session interface and publication rights before enabling live data. The simulator covers the local pipeline.
- **Owner input before public distribution.** Choose publisher identity, signing credentials, release channels, target OS versions and approved product branding. These decisions gate public installers, not local development.
