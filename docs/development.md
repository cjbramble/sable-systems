# Local development notes

For installation and commands, see the [README](../README.md).

## Local data

The database initializes automatically with four distributors, catalog inventory,
orders dated 2021–2031, shipments, returns, account records, and support incidents.

- Database state and runtime files: `.wrangler/`
- Model server logs: `reports/server-logs/`
- Schema and seed definitions: [db/schema.ts](../db/schema.ts) and [db/seed.ts](../db/seed.ts)

Runtime directories are Git-ignored. Existing records are preserved on startup;
interrupted initialization resumes from the last committed batch.

### Data maintenance

Schema versions 6, 7, and 8 upgrade to 9 with the current `SEED_VERSION`. Unsupported
versions or populated databases without version metadata stop startup without
modifying records. Preserve the database and inspect its metadata before migration.

Seed changes must update `SEED_VERSION` to prevent resuming initialization with a
different dataset. A version change does not reset existing data; rebuilding the
dataset requires a separate, explicit reset.

## Security boundaries

This is a local demo with synthetic data and published demo credentials.
`npm run dev` and `npm start` bind to loopback and explicitly enable the
`SABLE_LOCAL_DEMO=true` Worker binding. Authentication requires both that binding
and a loopback request hostname. `npm run build` emits a configuration with the
binding disabled, so accidentally deploying the build does not enable the demo
accounts or accept their existing sessions. A hostname check is not a network
firewall: do not expose the opted-in local runtime through a proxy or tunnel.
Public hosting requires replacing demo provisioning with private accounts and a
deployment-specific access policy.

Login permits 10 attempts per normalized email and 60 attempts across the app per
60-second window. Model generation permits 30 customer requests per user per
60-second window, shared across sessions; an automatic corrective model retry is
part of the same customer request. Limits are stored atomically in D1, survive
worker restarts, return HTTP 429 with `Retry-After`, and fail closed if storage is
unavailable. Saved reply replay and server-built record replies do not consume
model quota. Expired quota rows are removed when checking a quota.

Assistant Markdown cannot render images, including external tracking images;
raw HTML remains disabled. Logout clears the browser cookie only after server
revocation succeeds, leaving failed sign-outs retryable.

Run `npm run audit:deps` to check the lockfile against current npm advisories.
The scoped `image-size` override patches Vinext's exact transitive pin to 2.0.3;
remove it when the application adopts a Vinext release that no longer needs it.

## Demo recordings

`npm run demo:record` records the app workflow with live OpenRouter inference
and incurs API charges.
`npm run demo:record:tests` records the existing checkout test and generates its
report. Both commands build the app and use disposable databases. Recording
configuration lives in `tools/demo/`; raw videos, traces, and reports are saved
under the Git-ignored `reports/demo-recordings/`. Approved MP4s and thumbnails
live in `docs/media/`.
