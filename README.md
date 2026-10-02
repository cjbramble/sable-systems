# SABLE Systems Distribution Portal

A local web application for the fictional SABLE Systems wholesale business.
The portal provides inventory-aware ordering, charge-account checkout, order
history, and COV-E customer support. This branch trials DeepSeek V4.1 Flash
through OpenRouter. No local model weights or inference server are required.

Built with React, Vinext, and Tailwind CSS, with a Cloudflare Workers backend
and a D1/SQLite database.

## Demos

Select a thumbnail to open the video.

| Order to support · 36 seconds                                                                                                    | Playwright checkout test · 21 seconds                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [![SABLE landing page](docs/media/app-demo.png)](docs/media/app-demo.mp4)                                                        | [![Playwright checkout recording](docs/media/checkout-test.png)](docs/media/checkout-test.mp4)                                                                |
| Place an order, then ask COV-E for its details and shipment status. This recording shows the historical local inference version. | Watch the existing checkout test run and its passing report. Checks cover cart removal, account charges, inventory reservations, and persisted order history. |

## Setup

Requirements:

- Node.js 22.13 or later and npm.
- An OpenRouter API key with credits for hosted inference.

Install dependencies from the repository root:

```sh
npm ci
```

Create the ignored local environment file if it is missing:

```sh
cp .env.example .env
```

Fill in `OPENROUTER_API_KEY=` in `.env`, then start:

```sh
npm run dev
```

Open [http://127.0.0.1:8016](http://127.0.0.1:8016). The launcher starts the web
app and uses the OpenRouter key server-side. Press Control-C to stop it.

Inference pins `deepseek/deepseek-v4.1-flash` to the DeepInfra FP8 endpoint, disables
provider fallback, and retains the authorization, grounding, and corrective-retry
checks. COV-E disables reasoning; the advisory judge uses `z-ai/glm-5.3-flash`
with reasoning enabled and a
16,384-token output budget. Hosted requests send the question, scoped records,
and saved conversation history to OpenRouter and the selected provider. See
[OpenRouter inference](docs/inference.md) for testing and Cloud setup.

## Configuration

The application listens on `127.0.0.1:8016`. Inference uses OpenRouter HTTPS.
The launchers read `.env`; shell values take precedence. Unconfigured checkouts
require an API key for inference. `.env.example` contains the supported settings.

| Variable                      | Purpose                                   | Default                               |
| ----------------------------- | ----------------------------------------- | ------------------------------------- |
| `OPENROUTER_API_KEY`          | Server-side OpenRouter secret             | No key; required for hosted inference |
| `OPENROUTER_SUPPORT_MODEL`    | Hosted COV-E model ID                     | `deepseek/deepseek-v4.1-flash`        |
| `OPENROUTER_JUDGE_MODEL`      | Hosted advisory judge model ID            | `z-ai/glm-5.3-flash`                  |
| `OPENROUTER_JUDGE_REASONING`  | Hosted judge reasoning, `true` or `false` | `true`                                |
| `OPENROUTER_JUDGE_MAX_TOKENS` | Hosted judge reasoning plus verdict limit | `16384` (range `256`–`32768`)         |
| `SITE_URL`                    | Base URL for site metadata                | `http://127.0.0.1:8016`               |

The chat and judge defaults and provider/privacy policies are configured separately
in `lib/openrouter-config.json`. COV-E uses an 8,192-token prompt
budget with a 600-token reply limit and reasoning disabled. The judge uses
reasoning and a 16,384-token completion limit. Existing environment overrides
still take precedence; raise an explicit `OPENROUTER_JUDGE_MAX_TOKENS=8192`
override to `16384` to use the larger cap. Chat model overrides must be supported by the pinned DeepInfra FP8 endpoint.
The judge lets OpenRouter select a compatible endpoint with required parameters,
zero data retention, and data collection denied; there is no provider fallback.

## Usage

| Route      | Function                                              |
| ---------- | ----------------------------------------------------- |
| `/`        | Brand landing page                                    |
| `/login`   | Distributor sign-in                                   |
| `/shop`    | Catalog, case-pack cart, and charge-account checkout  |
| `/orders`  | Distributor order history, search, and status filters |
| `/support` | COV-E chat and per-user incident history              |

Sign in with a seeded local account:

| Distributor                       | Email                              | Access phrase     |
| --------------------------------- | ---------------------------------- | ----------------- |
| Calder Pike Distribution          | `mara.venn@calderpike.example`     | `Sable-WHS-0427!` |
| Meridian Civic Supply             | `imani.kade@meridiancivic.example` | `Sable-WHS-1098!` |
| Northline Prosthetics Cooperative | `rowan.sato@northline.example`     | `Sable-WHS-2714!` |
| Halcyon Industrial Exchange       | `lena.orr@halcyonexchange.example` | `Sable-WHS-5830!` |

Checkout reserves available inventory and validates case-pack quantities,
purchase-order references, and requested ship dates. COV-E provides read-only
assistance with authorized orders, shipments, returns, account charges, support
incidents, and inventory.

## Local data

The database initializes automatically with four distributors, catalog inventory,
orders dated 2021–2031, shipments, returns, account records, and support incidents.

- Database state and runtime files: `.wrangler/`
- Model server logs: `reports/server-logs/`
- Schema and seed definitions: [db/schema.ts](db/schema.ts) and [db/seed.ts](db/seed.ts)

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

## Testing

### Tools

| Tool                     | Role                                                                  |
| ------------------------ | --------------------------------------------------------------------- |
| Vitest                   | Unit, integration, and live-model tests; assertions, mocks, and spies |
| Cloudflare Vitest plugin | Runs Vitest tests in the Workers runtime                              |
| Miniflare                | Local Workers runtime setup and disposable D1 databases               |
| Playwright               | Chromium browser workflows using page objects                         |
| pytest                   | Python judge-adapter and mocked HTTPS tests                           |
| DeepEval                 | Advisory rubric judgments using OpenRouter with reasoning             |

Oxlint provides lint checks, TypeScript checks types, and a custom validator checks
the seed dataset.

### Test setup

Install Chromium for browser tests:

```sh
npx playwright install chromium
```

For Python judging and its offline tests, install `uv` and prepare the locked
environment:

```sh
npm run setup:judge
```

This installs Python 3.12 and the judge dependencies. DeepEval telemetry and
cloud reporting are disabled; live judging makes explicit, billed OpenRouter
requests. Interrupted runs retain partial evidence. Ordinary unit/integration
and browser tests use dummy credentials and mocked responses; they do not
forward your real key or incur inference charges.

### Commands

| Command                 | Runs                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------ |
| `npm test`              | Deterministic unit and integration tests                                                         |
| `npm run test:e2e`      | Production build and browser tests                                                               |
| `npm run test:model`    | Live chatbot factuality tests, repeated sampling, then advisory judging (billed with OpenRouter) |
| `npm run test:judge`    | Default 30-case calibration; selectable expanded suites (billed with OpenRouter)                 |
| `npm run test:python`   | Judge-adapter unit tests; no model server required                                               |
| `npm run validate:data` | Seed-data validation                                                                             |
| `npm run check`         | Lint, format check, type checks, application and Python tests, seed validation, and build        |

Python evaluator tests are included in `npm run check`; run `npm run setup:judge`
first. Browser and live-model suites run separately. `npm test` covers only the
application unit/integration tests.
Database tests use disposable local databases. Browser tests use controlled
model responses.

## Evaluation documentation

- [Evaluation methods and commands](docs/model-evaluation.md)
- [Chatbot behavior and threat model](docs/genai-behavior-threat-model.md)

Evaluation results and history are in [reports/](reports/README.md).
