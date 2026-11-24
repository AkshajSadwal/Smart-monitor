# X content policy and release gates

Reviewed on 21 November 2026 against the public X terms. The agreement and account-specific license for the actual deployment control its entitlement. Recheck them before enabling live delivery. [X Developer Agreement](https://docs.x.com/developer-terms/agreement) · [X Developer Policy](https://docs.x.com/developer-terms/policy)

## Confirmed public requirements

- X generally limits automated third-party redistribution to IDs. Its public policy sets a limit of 1,500,000 post IDs per recipient entity over 30 days without written permission, and describes a distinct limited exception for manual downloads. Automated SSE publication of full objects falls outside that manual exception. The policy also requires applicable X terms to be accepted by recipients where it specifies that condition. [X Developer Policy](https://docs.x.com/developer-terms/policy#content-redistribution)
- Public display should use the current API version of content or the official X widgets. Custom full-post display carries attribution, integrity, timestamp, action or permalink, and edit-history requirements. Using an official widget can handle rendering, while privacy notice, consent and opt-out obligations still apply to the embedding service. [X Display requirements](https://docs.x.com/developer-terms/display-requirements) · [X Developer Policy](https://docs.x.com/developer-terms/policy#public-display-of-posts)
- When stored X content is altered, protected, withheld or deleted, keep it current or remove it as soon as reasonably possible. The published terms also establish a 24-hour deadline after applicable removal requests. This deadline differs from the application's freshness policy. Agreement termination carries separate deletion obligations. [X Developer Agreement](https://docs.x.com/developer-terms/agreement) · [X Developer Policy](https://docs.x.com/developer-terms/policy#content-compliance)
- The pricing page directs operators to the Developer Console for current, endpoint-specific rates and balances. A local reservation estimates exposure and cannot reconcile actual credit charges. [X API pricing](https://docs.x.com/x-api/getting-started/pricing)

## Application policy

| Source or publication mode | Held locally or sent | Release gate |
|---|---|---|
| Simulated | Synthetic content and metrics. The VM can deliver synthetic events. | No X credential or collection permission |
| Official API or OAuth | Minimal normalized post fields needed for local matching and engagement history. The UI uses a permalink, fresh authorized metadata and the user's own match explanation. Personal signals stay in the profile. | An entitled and appropriately configured app. Review local storage and use case against its agreement. |
| Hosted IDs | The server publishes a post ID and locally generated delivery metadata. Restricted source fields are blank or null in the compatible wire shape. The app derives the original link. It stays unresolved and cannot alert until a local credential supplies authorized text. | Operator permission reference, applicable recipient terms and spending controls |
| Hosted metadata | The server publishes ID, timestamp and available engagement counters. Text, author fields and language are removed before storage and transmission. It stays unresolved for ranking. | Additional redistribution rights for those exact fields and explicit operator attestation |
| Hosted approved-public | Full collected record within the approved public topic scope. The worker stores eligible replay data for at most one hour and the app scores locally. Standard cards use summaries and links. | Written redistribution rights covering automated delivery, fields, recipients and caching. A local flag records the operator's attestation. |
| Official widget | Optional sandboxed rendering from X after the local setting and per-view consent. An X permalink works independently. | Operator review of the use, privacy notices and consent requirements. Verify rendering with a permitted public post. |
| User-selected sharing | A selected excerpt and permalink stored in the local profile. The selection cannot hydrate an ID or trigger an alert. | User choice and applicable content rights |
| Website-session collection | No production network driver | Express authorization for an approved integration |

The hosted boundary constructs and validates the permitted payload before writing replay rows or serving them. Live subscriptions require a recipient acknowledgement, and the service has a conservative shared cap of 1.5 million live delivery attempts across all recipients in the rolling window. Replay attempts count again. This is stricter than a per-entity cap within one service. Operators with multiple installations must account for combined delivery separately.

Authorized hydration is opt-in and uses the installation's own app-only API credential and its local monetary and request ceilings. The VM receives only approved public topics and its own client token. A denied or partial lookup leaves the post unresolved and surfaces a safe diagnostic.

## Expiry, removal and backups

- The app hides stale API metadata at 24 hours pending successful verification. It cleans stale cached text in bounded batches. The configured local retention applies to profile history and is separate from X removal obligations.
- A confirmed API removal purges local cached content across sources and keeps an unavailable notification record for deduplication. Use `npm run monitor -- purge-x POST_ID --confirm` to process a specific removal locally. Use `docker compose -f services/hosted-collector/compose.yaml run --rm hosted content purge POST_ID` on the VM. The service removes replay payloads and keeps a hashed suppression marker. Verify every affected installation and any retained copies.
- Hosted live replay retention is bounded. For metadata and full-field delivery the maximum is one hour. This is an application setting and does not independently authorize caching. Existing legacy tokens must be reissued if operator policy requires expiry.
- Store backups privately, with a defined deletion procedure. An operator must handle consent withdrawal, written takedowns, downstream cleanup, export access and copies in backups or other services. Automated entitlement-specific compliance ingress and end-to-end propagation to disconnected clients remain external release gates.

## Before enabling any live deployment

Confirm the operator's account terms and specific fields, cache duration, purpose, audience, provider hard limits and removal procedures. Record written approval for automated metadata or full-record redistribution. Verify the widget consent text for the deployment and the actual public TLS endpoint. Until those checks pass, use simulation for hosted acceptance.
