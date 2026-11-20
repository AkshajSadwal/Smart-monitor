# Data collection feasibility

For the implemented multi-source configuration, see the [multi-source setup and VM guide](09-multi-source.md).

**Evidence reviewed 20 November 2026.** This is a documentation and source review. No paid request, account login, browser capture or entitlement test was performed. Verify prices, allowed use and endpoints in the owner's Developer Console before a live run.

## Access options

| Option | Coverage and latency | Operational cost and decision |
| --- | --- | --- |
| Seeded simulator | A finite, repeatable, synthetic timeline with replayed IDs, partial metrics and later snapshots. A virtual clock controls arrival | No account, network, secrets or fees. Ship first. Namespace all posts and mark every display surface Simulated |
| Official recent search | Public posts matching supported operators in a rolling seven-day window. One fetch per due query group plus bounded pagination | First live collector. Owner supplies a developer project/app with credits and read access. Default five-minute polling. Results can arrive later than one interval |
| Official filtered stream | Persistent connection for matching incoming posts. X publishes approximately 4–5 seconds P99 on its side. Disconnects, local processing and OS delivery add latency | Optional after polling. Pay-per-use documents one connection, 1,000 rules and 1,024 characters per rule. Confirm entitlement, manage only app-owned tagged rules and show gaps |
| Playwright with a signed-in browser | Can drive a real browser and persist authenticated state. A page exposes a changing UI with partial results and no guaranteed completeness or latency | Unsuitable as a shipping X collector. The account holder's consent does not grant permission from X. Browser storage can impersonate the user. Use Playwright for tests of the local UI |
| Unofficial clients | Twikit is a third-party Python client for X's internal interface. Its release history records fixes to login and other changing behavior | Adds a second runtime, account/session handling and an unstable upstream. Published releases do not establish current compatibility or authorization. Exclude from implementation |

Evidence for the access comparison comes from the providers and maintainers. [Recent search](https://docs.x.com/x-api/posts/search/introduction) · [Filtered stream access levels and latency](https://docs.x.com/x-api/posts/filtered-stream/introduction) · [Playwright authentication](https://playwright.dev/docs/auth) · [Twikit repository](https://github.com/d60/twikit) · [Twikit releases](https://github.com/d60/twikit/releases)

X explicitly restricts non-API website automation and warns of suspension. Thus authenticated scraping, session import, guest scraping and switching identities after a denial are outside the design. A future change in permission would require written terms and a fresh feasibility review. The official TypeScript XDK is an alternative to a small typed HTTP adapter. Choose Node fetch initially so the scheduler directly observes status, rate headers and cursor advancement. [X automation rules](https://help.x.com/en/rules-and-policies/x-automation) · [Official TypeScript SDK](https://github.com/xdevplatform/xdk-typescript)

## What a live read can cost

Public pay-per-use prices list **US$0.005 per post read** and **US$0.010 per user read**. At 200 distinct billed posts per day for 30 days, the post component is $30. At 2,000 per day it is $300. User expansions, relationship resources and other calls can change the bill. Following resources are listed at $0.010 each. Eligible reads of the developer app owner's own follows and likes qualify for $0.001 per resource. Confirm actual resource classes in the console. X describes UTC-day deduplication as a soft guarantee and lists a three-million-post monthly pay-per-use cap. [X API pricing, owned reads and deduplication](https://docs.x.com/x-api/getting-started/pricing)

**Product decision.** No paid calls until the owner chooses a source and budget. Show projected usage from page size, number of query groups and schedule. Start with 10 results per page, two pages per query group per cycle, one HTTP request at a time, user-controlled daily request and resource ceilings, and a monthly dollar ceiling in the Developer Console. Reserve the worst-case page cost, including expansions, before dispatch. A timeout consumes the reservation until reconciliation. Do not assume deduplication savings. Streaming can deliver a burst before cancellation, so require an explicit provider-side ceiling and separate opt-in. Local usage is an estimate. Display the reset boundary and the reason when the collector pauses.

## Endpoint and signal contract

| Capability | Endpoint / authorization | Handling in the monitor |
| --- | --- | --- |
| Search | GET /2/tweets/search/recent, app-only bearer for public search | Map positive terms to a supported query. Page with next_token. Apply the authoritative rule locally |
| Refresh posts | GET /2/tweets with a bounded list of retained IDs | Request available public_metrics, author_id, created_at, lang, referenced_tweets and edit history where available. Parse per-ID errors alongside successes |
| Author identity | expansions=author_id with user.fields=username,name,profile_image_url when budget permits | Store source ID even when expansion is absent. Keep unknown author attributes nullable |
| Account identity | GET /2/users/me with user-context OAuth 2.0 authorization code + PKCE | Bind private signals to this account ID and credential generation. Request tweet.read and users.read for applicable reads |
| Following | GET /2/users/{own-id}/following, delegated scopes including follows.read | A positive member is known. A missing member is unknown until a complete fresh sync. Never infer follows from posting frequency |
| Liked authors | GET /2/users/{own-id}/liked_tweets, delegated scopes including like.read | Keep author affinity from returned liked posts. A limited or partial history supplies positive evidence only. Avoid keeping the user's liked-post text |
| Stream | GET /2/tweets/search/stream, app-only bearer | The operator manages stream rules in the developer application. The monitor reads the stream and uses recent search for catch-up |
| Local-only | Favorites, mute, important terms, feedback, local bookmarks | Available for both sources, namespace mock author IDs. Generic browsing history, silent views by the user and private account activity are unavailable |

Check the endpoint authentication mapping and the actual app's scopes before advertising a capability. Request offline.access only when delegated refresh is enabled. Ask for the minimum additional scope when enabling each signal. Missing permission disables that signal independently of public search. [Authentication mapping](https://docs.x.com/fundamentals/authentication/guides/v2-authentication-mapping) · [Likes](https://docs.x.com/x-api/posts/likes/introduction)

Recent search documents 450 requests per app or 300 per user per 15 minutes, up to 100 results per request and a 512-character query. The published stream connection limit is 50 attempts per 15 minutes. Limits count calls, while billing can count returned resources. Honor the most restrictive of the response headers, the app's entitlements and user budgets. [Endpoint limits](https://docs.x.com/x-api/fundamentals/rate-limits)

## Retrieval, gaps and retention

1. Compile controlled query syntax from validated positive term groups. Use quoted phrases and split large OR groups under the endpoint limit. For ALL rules, one required positive term can retrieve candidates for local filtering. Never truncate a term or silently drop one arm of an OR. Show an unsupported rule as local-only if a safe upstream candidate query cannot be formed. Disable empty and exclusion-only queries. Preview estimated breadth before enabling a costly list.
2. Freeze a bounded search interval per query revision. On first start use the past 15 minutes, labeling prior posts as history with alerts disabled. Page newest-first, persist pending page token, query, time bounds and highest observed ID. Advance the completed watermark only when all pages commit. On token expiry, replay the frozen range with idempotent upserts. On watchlist edits start a new revision. Treat IDs as strings and compare numeric X IDs without loss of precision. [X pagination](https://docs.x.com/x-api/posts/search/integrate/paginate)
3. On restart or stream loss, record the interval of uncertainty. Use budgeted recent search to fill covered queries when supported. Cap automatic recovery to the last hour and expose older gaps, including any period beyond the seven-day window. Suppress historical OS alerts. Mark an active stream connected only after the upstream connection succeeds. A budget stop closes that connection.
4. Reconcile stored X content, including edits, visibility and deletions. Maintain a short-lived display cache, confirm availability through authorized lookup within 24 hours as a product freshness target, and hide expired content until checked. On confirmed unavailability remove the cached content, author details where appropriate, text-bearing explanations, notification previews and search indexes. On transient failure hide stale data without treating it as a confirmed deletion. Process removal requests promptly, including when identifiers appear in logs or backups. Avoid retaining raw responses or persistent live-content backups. Local retention alone does not cover removal obligations. [X Developer Policy](https://docs.x.com/developer-terms/policy)
5. Before live release, verify display requirements for the actual post cards and notifications, the described personal-monitoring use case and public brand. Keep sensitive profiling, redistribution and behavioral surveillance outside this local topic monitor. If a permitted storage/display pathway or essential access cannot be demonstrated, keep that capability disabled and document the result. [X Developer Agreement](https://docs.x.com/developer-terms/agreement) · [X Developer Policy](https://docs.x.com/developer-terms/policy)

## Evidence still needed for live acceptance

The owner must supply a permitted app, explicit test budget and, for private signals, an authorized test account. Record redacted results for one search, one paid-page budget decision, presence/absence of each requested field, one batch lookup, and optional scope/stream probes. Test authorization failures, a 429, clock skew, incomplete pages and revoked consent with fixtures. Do not create deliberate rate-limit traffic. Describe unsupported capabilities individually in Data Sources and keep simulated mode fully usable.
