# Database and local API specification

## Storage contract

Use versioned SQL migrations, UTC epoch milliseconds in INTEGER columns, TEXT for all external IDs, and local UUIDs for editable entities. Normalize source identity as a namespace (mock fixture family or X), with a separate source connection ID and generation for operational state. A new credential must never inherit another user's personal signals. Store compact validated JSON for explanations, capabilities and versioned settings. Keep searchable fields, relationships and uniqueness constraints relational.

| Table | Key columns and invariants |
| --- | --- |
| schema_migrations | version PK, checksum, applied_at. Validate known checksums, reject a newer unsupported schema |
| data_sources | id PK, namespace, mode, status, account_id?, capability_json, vault_ref?, generation, last_success_at?, error_code?, active. Unique partial index for one active row |
| watchlists | id PK, name, enabled, mode ANY/ALL, min_engagement, language?, standard, immediate, cooldown_s, revision, created_at, updated_at. CHECK 0 ≤ standard ≤ immediate ≤ 100 |
| keyword_rules | id PK, list_id FK cascade, direction include/exclude, kind word/phrase/hashtag, display_term, normalized_term, important. Unique (list_id, direction, kind, normalized_term) |
| watchlist_authors | list_id FK cascade, namespace, normalized_handle or author_id, role allow/favorite, unique selector + role per list. Keep allow and boost independent |
| authors | PK (namespace, id), handle?, display_name?, avatar_url?, last_verified_at. Preserve a missing expansion as unknown |
| posts | PK (namespace, id), canonical_id, author_id?, text?, lang?, url?, kind original/reply/repost/quote/unknown, referenced_id?, created_at?, first_seen_at, last_seen_at, source_id, content_hash?, display_verified_at?, visibility. FK author within namespace. Real URLs derived from validated provider IDs; mock url null |
| post_display | PK (namespace, post_id), post FK cascade, validated entities_json, edit_ids_json, display_kind and fetched_at. Cache only fields needed for an attributed card; fall back to a monitor summary when full display is unavailable |
| engagement_snapshots | PK (namespace, post_id, collected_at), likes?, reposts?, replies?, views?, post FK cascade. Unknown is NULL, observed zero is 0. Only nonnegative counters |
| account_relationships | source_id, account_id, author_id, kind following/liked-author, value, observed_at, expires_at, sync_generation. Unique per account/author/kind; sync completeness in the source's job state |
| author_preferences | PK (namespace, author_id), favorite, muted, updated_at. Mute wins over favorite |
| scores | PK (namespace, post_id, list_id), post/list FKs cascade, rule_revision, model_version, settings_revision, score, matched_rule_snapshot, reason_json, classification, suppression?, scored_at. One current score per match. Notification snapshots preserve the decision at send time |
| feedback | PK (namespace, post_id), post FK cascade, rating useful/irrelevant/null, favorite boolean, updated_at. Upsert desired state so a client retry contributes once |
| notifications | id PK, namespace, canonical_id, post_id?, winning_list_id? FK SET NULL, decision_at, local_day, kind standard/immediate/delayed, score, safe reason snapshot, read_at?, dispatch_state, attempted_at?, delivery_code?. UNIQUE (namespace, canonical_id). Redact reasons when underlying live content is removed |
| monitoring_jobs | id PK, unique dedupe_key, type, source_id?, generation, query_revision?, post_id?, due_at, attempt, lease_until?, payload_json, status. Holds scheduled polls, frozen page cursors, delayed evaluation, rechecks, freshness, dispatch and cleanup. Include the source or list generation in relevant keys |
| usage_buckets | source_id, period_start, category, reserved, consumed, PK on source/period/category. Separate request counts, resource reservations and estimated cost. Persist ambiguous reservations on timeout |
| notification_limits | local_day and time-zone key for global count, separate list_id → last_alert_at. Update in the same transaction as accepting a notification. A timezone edit preserves already consumed slots for the current day |
| settings | key PK, value_json, revision. Store schema-validated settings and profile settings revision. Keep secrets in the vault |

Use indexes on (namespace, created_at, id), (namespace, author_id, content_hash, first_seen_at), (list_id, score, post_id), (namespace, read_at, decision_at), (status, due_at), relationship expiry and freshness deadlines. Use a derived sort_time = coalesce(created_at, first_seen_at) with an expression index for stable feed pagination. Bound text search to retained rows; use escaped literal substring matching for the MVP and introduce a purge-aware FTS index only after measuring need.

**Migration order.** 001 creates source/settings, rules, authors, posts, matches/scores and monitor state. 002 adds nullable snapshots, account preferences, feedback, notification history and dispatch constraints. 003 adds budgets, leases, freshness metadata and indexes. Backfill old source IDs and first-seen/sort data before tightening constraints. Record a version only after all steps succeed. Use SQLite's consistent backup mechanism for a restricted migration copy, delete it after success or recovery, and test rollback under low disk and interrupted startup. Refuse to open an incompatible database with an older binary.

**Commit boundaries.** Parse and validate provider responses before a write transaction. Upsert authors and posts, save one snapshot per observation, compute current matches and scores, enqueue due jobs and advance the page cursor in the same transaction. Publish events after commit. Detect replayed observations by source page/observation identity; persisting a pending page's observation ID makes replay time stable. Cursor expiry can return an old ID with a genuinely newer observation. Preserve newer fields when merging a partial response. Give per-page partial errors explicit handling and record coverage gaps. A lease expiry may re-run work; all writes must still be idempotent.

Edits increment the watchlist revision and invalidate its pending queries. Existing feed rows show the rule/revision that matched them until next evaluation. Deleting a list cascades only its rules, scores and list-scoped jobs; unrelated rows survive. Historical alerts retain a sanitized winning-list label. Purge and confirmed provider removals cascade through derived data and remove text from outbox and history. Preserve a minimal opaque dedupe marker only during its lawful retention window. A user erase removes those markers too.

Default retention is 30 days from first collection, configurable 1–90 days. Run daily bounded cleanup in batches of 250; delete expired content, dependent snapshots/feedback, completed jobs and orphan authors lacking a user preference. Expire notifications and dedupe markers after the same window. Personal signal refresh defaults to daily with a 24-hour TTL. Successful checkpoint and incremental vacuum can reclaim space during idle time. Apply live-content freshness and removal rules independently of ordinary retention.

## Local HTTP contract

Prefix /api/v1. JSON objects use camelCase. Return 201 for creation, 200 for reads/updates, 202 for scheduled work, and 204 for no-content success. Authenticated mutations require a session and CSRF header, with origin/host validation. The session exchange validates the single-use nonce and exact origin before issuing credentials. The OAuth redirect validates state, callback address and PKCE binding. Unauthenticated status reveals only process liveness and bootstrap protocol version. Protect all application, account and diagnostic data. Unknown request fields are rejected.

| Method and route (under prefix) | Request and result |
| --- | --- |
| GET /health · POST /session | Minimal liveness; exchange single-use CLI nonce for local cookie and CSRF token |
| GET /overview · GET /monitor | Counts and recent item IDs by source/local day; persisted monitoring state, last success, next due, active jobs, safe error and source mode |
| PUT /monitor | Set desired paused boolean; repeated requests leave the same state. Respond with effective state/generation |
| GET, POST /watchlists · GET, PATCH, DELETE /watchlists/{id} | List, create, detail, replace changed fields or delete. Require expected revision on changes. Update list/rules atomically |
| POST /watchlists/preview | Draft rule plus bounded sample post; return eligibility, matched terms, score breakdown and reasons. No writes or upstream calls |
| GET /posts · GET /posts/{namespace}/{id} | Feed with q, source, listId, priority, kind, sort, cursor and limit. Detail adds per-list reasons, signal availability, snapshots, source and safe original URL |
| PUT /posts/{namespace}/{id}/feedback | Desired rating and favorite state. Return persisted feedback and updated affinity; past notification snapshots are fixed |
| GET /authors/preferences · PUT /authors/{namespace}/{id}/preferences | List or change local favorite/mute state. Muting also cancels pending alert jobs for that author |
| GET /notifications · PUT /notifications/{id}/read · POST /notifications/read-all | Paginated history filtered by source/read state. Set read boolean or mark selected source through a supplied cutoff, preserving later arrivals |
| POST /notifications/test | Return platform support and delivery attempt result for a clearly marked test. Separate from production quotas |
| GET /sources · PUT /sources/{id}/active | List source states/capabilities and select a configured source. Cancel jobs from the previous source generation |
| POST /sources/{id}/authorize · GET /oauth/callback | Start state-bound PKCE consent and consume one authorization response via the registered callback path. Return setup status only. Register the exact prefixed path or route it through the dedicated callback listener |
| POST /sources/{id}/check · POST /sources/{id}/disconnect | Run a budgeted capability check or disconnect. Clear private signals, pending requests and vault refs. Paid probes require enabled budget |
| GET, PATCH /settings | Versioned typed preferences including interval, caps, quiet hours, time zone, global important terms, weights, retention, motion and OS notification preference. Startup reports capability and requested/effective state |
| GET /events | Authenticated same-origin SSE stream of committed invalidations |
| POST /data/erase | Accept explicit confirmation and short-lived operation nonce issued by authenticated POST /data/erase-preview with affected counts; stop jobs, erase profile and vault, invalidate sessions. CLI status reports incomplete cleanup on error |

**Create example — POST /api/v1/watchlists**

~~~json
{
  "name": "SQLite releases",
  "enabled": true,
  "mode": "ALL",
  "terms": [
    {"direction":"include","kind":"word","text":"SQLite","important":true},
    {"direction":"include","kind":"phrase","text":"release candidate"},
    {"direction":"exclude","kind":"word","text":"hiring"}
  ],
  "allowedAuthors": [],
  "favoriteAuthors": [],
  "language": "en",
  "minEngagement": 0,
  "standard": 70,
  "immediate": 85,
  "cooldownSeconds": 300
}
~~~

Return the normalized object with id, revision=1 and timestamps. PUT/PATCH clients send the revision via If-Match on versioned resources. Respond 409 with the current revision for a stale editor; the UI can reload and reapply changes.

**Representative response — GET /api/v1/posts/mock/demo-03 (selected fields)**

~~~json
{
  "id":"demo-03","namespace":"mock","simulated":true,"originalUrl":null,
  "text":"SQLite release candidate is ready","kind":"original",
  "metrics":{"likes":null,"reposts":null,"replies":null,"views":null},
  "matches":[{"listId":"b819efcd-9650-4d3d-9274-bf632b330758","score":100,
    "modelVersion":1,"availableWeight":35,
    "signals":[{"key":"term","value":1,"weight":35}],
    "unavailable":["popularity","velocity","following","likedAuthor","favorite","feedback"],
    "penalties":[],"classification":"immediate"}]
}
~~~

**Input bounds and errors.** Names 1–80 characters, terms 1–100 code points, up to 32 terms per list, at least one inclusion. Deduplicate normalized terms. Limit profile to 100 lists, 100 selectors per list, search text to 200 characters, JSON body to 64 KiB and feed page to 1–100 (default 30). Validate handles, UUIDs, language tags, IANA zones, nonnegative counters, weights 0–100, time strings HH:mm, thresholds 0–100 and polling interval 60–3,600 seconds. Distinguish disabled quiet hours from equal endpoints (reject ambiguous enabled interval). Persist interval changes for the next run. Return stable errors, e.g. {"error":{"code":"INVALID_THRESHOLD","field":"immediate","message":"Immediate must be at least the standard threshold."}}. Use 400 invalid input, 401 unauthenticated, 403 forbidden action, 404 absent, 409 conflict, 429 local budget throttle with reset time, 503 unavailable vault/service.

**Paging and updates.** Keyset cursors encode sort, filter fingerprint and last (sort value, namespace, id). Reject malformed or reused cursors for a different filter. Deduplicate by ID on refresh when scores reorder the feed. SSE publishes overview.changed, posts.changed, notifications.changed, watchlists.changed, settings.changed and source.changed with an instance epoch, sequence and affected IDs only. Keep a bounded in-memory replay buffer. On a missing sequence, service restart or slow consumer, send reset and refetch snapshots. Use SSE heartbeats only while a UI is connected. SSE transports local changes from both polling and streaming collectors.
