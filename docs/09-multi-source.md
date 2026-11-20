# Multi-source implementation plan

1. Preserve the desktop, SQLite history and ranker. Add collector IDs separately from post namespaces. Migration 4 seeds Local X Account and Hosted Monitoring, records collector provenance, and backfills collector-scoped jobs from existing IDs. Test upgrades from schema 3.
2. Move the simulation and network collectors behind a shared interface. Keep collector scheduling and checkpoints in the worker. Reuse X query grouping, normalization, and HTTP error handling.
3. Use documented X OAuth user-context reads for the local account adapter. Keep access and refresh credentials in the OS vault. Persist only operational metadata. Expose authentication, expiry, restrictions, reconnect and disconnect. Website-internal operations stay unavailable unless X explicitly authorizes a supported integration.
4. Add a standalone Fastify/SQLite hosted collector with a separate operator CLI, authenticated subscriptions, normalized query deduplication, bounded polling and SSE replay. Use administrative authorization for live redistribution and an independent operator credential. Test synthetic hosted delivery without an X account.
5. Wire consent, collector switching, telemetry, pagination controls and reranking into the existing APIs and Source cards. Approve the remote HTTPS destination and selected public terms explicitly. Keep account signals, watchlist filters, ranking and alerts local.
6. Verify parser and rate-limit fixtures, data migration, consent, network restrictions, subscription isolation, event resume, canonical duplicate alerts, browser checks and the Windows package. Prepare single-VM deployment files. Live permissions and a target VM are external acceptance gates.

## Reference comparison

The reference API separates operation definitions, cursor extraction and parsing of timeline items. We keep typed query and paging contracts around documented X routes. [twscrape/api.py](https://github.com/vladkens/twscrape/blob/main/twscrape/api.py)

The reference queue client classifies responses and coordinates temporary availability with an account pool. Our scheduler records persistent checkpoints and backs off one explicitly authorized identity. The hosted worker shares equivalent searches while keeping authorization and ownership separate. [queue_client.py](https://github.com/vladkens/twscrape/blob/main/twscrape/queue_client.py) · [accounts_pool.py](https://github.com/vladkens/twscrape/blob/main/twscrape/accounts_pool.py)

The reference account and login modules model session availability and website authentication. Our backend uses the system browser and documented OAuth consent, keeps secrets in the OS vault, and treats unsupported website operations as unavailable. [account.py](https://github.com/vladkens/twscrape/blob/main/twscrape/account.py) · [login.py](https://github.com/vladkens/twscrape/blob/main/twscrape/login.py) · [X authentication mapping](https://docs.x.com/fundamentals/authentication/guides/v2-authentication-mapping)

The reference models normalize heterogeneous records into typed posts and users. Our normalized Candidate keeps the existing X namespace, identifies the collector through provenance, and gates publication according to the hosted source and configured permission. [models.py](https://github.com/vladkens/twscrape/blob/main/twscrape/models.py) · [X Developer Policy](https://docs.x.com/developer-terms/policy)

The main risks are stale cursors, ambiguous redistribution, authorization revocation, SSRF at the configured hosted origin, and duplicate alerts across collectors. Automated tests exercise those boundaries with fixtures. Production readiness requires live entitlement, an actual redistribution decision and deployment verification.

## Local configuration

Run `npm ci`, `npm run build`, and `npm run monitor -- open` from the project root. The simulated collector can be selected any time. Schema 4 is additive. Existing posts, alerts, feedback and watchlists keep their IDs. A schema 3 worker cannot open an upgraded profile.

| Source | Configure | What is collected |
| --- | --- | --- |
| Official X API | Store your app-only credential with `npm run monitor -- credentials set` or the tray action. Set X budgets in Settings and select the source. | Documented recent search and lookup. Optional personal signals use separate account consent. Filtered Stream is opt-in, uses rules configured in the developer application and requires a provider-side spending ceiling. |
| Local X Account | Register `http://127.0.0.1:<port>/api/v1/oauth/session/callback` exactly as shown in Data sources. Set the X budgets, connect with the public OAuth client ID, authorize in the system browser, and explicitly select Local X Account. A fixed `MONITOR_PORT` can keep the redirect stable across restarts. | Documented OAuth user-context search and lookup, plus optional following and liked-author signals. The session can renew with separate offline-access consent. Passwords and browser cookies remain in the browser. Website-internal search, timelines and verification flows are unavailable. |
| Hosted Monitoring | Enter the public HTTPS origin, select public terms from enabled watchlists and confirm consent. Save the VM-issued client token with `npm run monitor -- hosted-credential set` or the tray action. Check connectivity, then select the source. | Authenticated SSE, with reconnect and a persistent cursor. Only approved literal topics go to the VM. Local filters, preferences, relationship signals, notification policies and X credentials stay local. |
| Simulated | Select Simulated and replay from Data sources if needed. | The existing seeded collector and engagement fixtures. |

Recent search stores frozen time windows and cursor checkpoints. Set 1–12 pages per query per cycle, 10–100 results per page, and a 1–168 hour recovery bound per X collector. Identical query groups share reads. A bounded rotation spreads work across large watchlists. An unsupported query, malformed or partial upstream page, abandoned time range or incomplete page window appears in coverage diagnostics. Gap-free results depend on the upstream source. A daily API budget is shared by the two local X modes. Rate-limit resets and terminal authorization failures stop the affected collector without selecting a different one.

The account sync records progress per account and signal. Optional refresh resumes saved pagination. An incomplete follow list supplies positive signals only. An access denial requires explicit reauthorization or a new connection check. Remove an account to delete its vault credentials and local relationship state. Revoke the grant in X to end access at the provider.

Stream delivery reaches the same local ranker as polling. The local worker reserves a bounded allowance per connection and continues recent-search catch-up. The provider's spending ceiling is essential because the publisher can send a burst before the local reader closes. If X denies the streaming endpoint, the Sources page reports that limitation while documented recent search can continue. [X Filtered Stream](https://docs.x.com/x-api/posts/filtered-stream/introduction)

X feed entries show a match summary, available metadata and a link to the canonical post. Simulated entries can show their full text. When the VM has permission to redistribute IDs only, those rows show an X link and stay unscored. A source that cannot provide text cannot reliably evaluate local keyword or exclusion rules. Full live previews or embeds require an approved presentation and visibility policy. [X post display requirements](https://docs.x.com/developer-terms/display-requirements)

Feedback and author preferences rerank stored matches locally without resending old alerts. Only new observations enter delayed-alert evaluation. Rechecks use recent comparable engagement samples, and canonical X ID deduplication applies across all collectors.

## Deploy the hosted service on a VM

Use a Linux VM with Docker Engine and the Compose plugin. Point a public DNS name at the VM and open 80 and 443 for Caddy. The hosted Fastify container has no published port. It uses a persistent SQLite volume and runs as the unprivileged Node user. Caddy terminates TLS and forwards unbuffered SSE.

~~~sh
export HOSTED_DOMAIN=monitor.example.com
export HOSTED_MODE=simulated
docker compose -f services/hosted-collector/compose.yaml config --quiet
docker compose -f services/hosted-collector/compose.yaml up -d --build
docker compose -f services/hosted-collector/compose.yaml run --rm hosted client issue "Installation A"
~~~

Keep the issued ID and deliver its token privately to that installation. Each installation needs its own token. Revoke a token with `docker compose -f services/hosted-collector/compose.yaml run --rm hosted client revoke <client-id>`. Operator commands are available over VM administration only. The public API offers health, the authenticated client's status and subscriptions, and authenticated SSE.

Modes are `disabled` (default), `simulated` (no X requests), `ids` and `approved-public`. Enable either live mode only after you establish permission for its fields. Set `HOSTED_PERMISSION_REFERENCE` to the approval record and configure positive `HOSTED_DAILY_REQUESTS` and `HOSTED_DAILY_RESOURCES`. Set the provider-side spending ceiling for the independent server app. Provide a 32-byte hex master key at `master.hex` in the mounted operator secrets directory. Keep the key separate from SQLite backups and readable by container UID 1000. Initialize it on the VM once, preserve it across restarts, and enter the server-owned credential without echo:

~~~sh
read -rsp "VM app-only X bearer: " VM_X_BEARER
printf '\n'
printf '%s' "$VM_X_BEARER" | docker compose -f services/hosted-collector/compose.yaml run --rm -T hosted credential set
unset VM_X_BEARER
docker compose -f services/hosted-collector/compose.yaml up -d
~~~

The worker holds one provider request at a time, polls at most four ready topics per scheduling pass, and shares equivalent normalized topics. Defaults cap the service at 200 active topics, 500 issued active clients, 16 topics per client, 100 SSE connections, and 20,000 retained events. Topics expire two hours after the last client lease update. Event retention defaults to 24 hours and can be set from 1 to 168 hours. Disconnect attempts to unsubscribe immediately. If the VM cannot be reached, the client shows that the lease will expire.

For an isolated local server smoke test use `npm run build:hosted`, then set `HOSTED_MODE=simulated` and run `npm run hosted`. It binds loopback by default. Use the automated tests for local desktop-to-VM protocol coverage. The desktop's production HTTPS transport rejects loopback, private and reserved addresses, IP literals, redirects and nonstandard ports. Use a reachable public TLS endpoint for the manual desktop test.

## Verification commands

Run `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run build:hosted`, `npm run test:hosted` and `npm run test:e2e`. The TypeScript tests exercise three collectors, including PKCE expiry, official streaming, consent and fixture delivery over the hosted protocol. The hosted server test binds an ephemeral loopback port and checks two clients sharing a query, event ownership and cursor resume. It needs loopback socket access.

For manual acceptance, start with Simulated. Exercise Official API search and stream with an approved app and a small explicit budget. Return to Local X Account, complete browser OAuth, collect an authorized result, restart the worker, then disconnect and confirm the session is removed. Then start a disposable hosted service in simulated mode with TLS, issue two tokens, approve overlapping topics, and verify each client receives only its own subscriptions while scoring locally. Before enabling live hosted mode, independently verify redistribution, deletion handling, permitted fields, and term-specific retention. Confirm Windows installation and activation and test macOS and Linux on their native hosts.

### Verification performed

- Passed TypeScript, ESLint, 18 service tests, three Chromium end-to-end tests and the production frontend, desktop service and hosted bundle builds.
- Passed the bundled-hosted smoke test and a Linux Docker test that issued a fixture client, subscribed and received a simulated SSE post. Compose and Caddy validated. The automated local monitor also consumed an actual loopback VM event and ranked it through the notification pipeline.
- Rebuilt the unsigned Windows x64 NSIS installer. The unpacked Windows app passed background collection, reopened state, tray-host activation and clean shutdown. Electron reported the notification test as submitted.
- Live X credentials, stream entitlement, OAuth revocation at X, public-domain TLS issuance, real hosted redistribution, signed installation and macOS/Linux desktop behavior require additional acceptance checks. Website-only collection and full live X previews stay unavailable pending the relevant permission and display review.
