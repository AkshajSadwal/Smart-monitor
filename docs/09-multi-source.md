# Collection sources and hosted setup

The desktop worker matches and ranks a shared post model. `apps/service/website-session.ts` manages the authorized read interface and `apps/desktop/account.cjs` manages interactive sign-in. `HostedClient` manages the local server token, approval and SSE checkpoint. The shared validator in `packages/collection-core/collector.ts` represents both session results and VM events. Canonical X IDs prevent a new duplicate feed row when an edited ID is seen from another source.

## Local X Account

Use **Data sources → Open X sign-in** in the Electron app. Enter credentials and complete any verification on X. **Remember my sign-in** requests a dedicated persistent Electron session when OS-backed protection is available. On Linux with no supported secure desktop store the app uses an in-memory session. Use **Check browser session** after signing in or restarting. The displayed status reflects the local browser session, and the X window shows the account identity. **Disconnect browser** closes it and clears the app's X partition. Manual post excerpts stay in SQLite and can be removed independently. Automated session collection remains **Unsupported**.

## Hosted Monitoring

Build and run a loopback-only simulated server in PowerShell. Issue credentials on the server with distinct labels for each client. Share each token privately with its recipient.

~~~powershell
npm run build:hosted
$env:HOSTED_DB = "$PWD\.local\hosted-test.sqlite"
$env:HOSTED_MODE = 'simulated'
npm run hosted -- client issue "Client A"
npm run hosted -- client issue "Client B"
npm run hosted -- serve
~~~

The desktop client expects a public HTTPS origin. For an authorized VM you administer, configure its DNS and open HTTPS/HTTP to Caddy. Leave the worker's port private.

~~~sh
HOSTED_DOMAIN=monitor.example.com HOSTED_MODE=simulated docker compose -f services/hosted-collector/compose.yaml up -d --build
docker compose -f services/hosted-collector/compose.yaml exec hosted node dist/hosted.cjs client issue "Client A"
docker compose -f services/hosted-collector/compose.yaml exec hosted node dist/hosted.cjs client issue "Client B"
~~~

Create enabled watchlists, then open **Data sources → Hosted Monitoring → Configure server**. Select the public topics you consent to send and enter the HTTPS origin. Use the tray or `npm run monitor -- hosted-credential set` to save the server token. Choose **Check connection** and **Use Hosted Monitoring**, then start. The VM receives public topics and its own client token. The desktop retains local filters, personalization, and browser sessions.

Revoke a client on the VM with `node dist/hosted.cjs client revoke CLIENT_ID` inside the hosted container. A revoked or expired token closes existing delivery and cannot reconnect. Host cleanup prunes topics after the last subscriber's lease expires. The client reconnects with its persisted replay position.

`HOSTED_MODE=disabled` is the default. Only `disabled` and `simulated` can start the bundled server. Live publication modes remain covered by fixtures for authorization boundaries, and the previous API-backed provider cannot be selected by the desktop client. For an older hosted database, stop its old worker and use `npm run hosted -- cleanup-retired-credentials --confirm` with the correct `HOSTED_DB` to clear retired encrypted operator entries. This action retains clients, subscriptions and events.

[Manual tests and recovery](10-manual-testing.md) · [Hosted content policy](12-content-compliance.md)
