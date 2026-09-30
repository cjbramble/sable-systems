# SABLE Systems Distribution Portal

A local web application for the fictional SABLE Systems wholesale business.
The portal provides inventory-aware ordering, charge-account checkout, order
history, and COV-E customer support. This branch trials DeepSeek V4.1 Flash
through OpenRouter, with the local Qwen3 4B runtime still selectable.

Built with React, Vinext, and Tailwind CSS, with a Cloudflare Workers backend
and a D1/SQLite database.

## Demos

Select a thumbnail to open the video.

| Order to support · 36 seconds                                                                                 | Playwright checkout test · 21 seconds                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [![SABLE landing page](docs/media/app-demo.png)](docs/media/app-demo.mp4)                                     | [![Playwright checkout recording](docs/media/checkout-test.png)](docs/media/checkout-test.mp4)                                                                |
| Place an order, then ask COV-E for its details and shipment status. Responses come from the local Qwen model. | Watch the existing checkout test run and its passing report. Checks cover cart removal, account charges, inventory reservations, and persisted order history. |

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

Open [http://127.0.0.1:8016](http://127.0.0.1:8016). With
`SUPPORT_MODEL_PROVIDER=openrouter`, the launcher starts only the web app;
no model weights or `llama-server` are required. The key is used server-side.
Press Control-C to stop the web app and its child processes.

The trial pins `deepseek/deepseek-v4.1-flash` to the DeepInfra FP8 endpoint, disables
provider fallback, and retains the authorization, grounding, and corrective-retry
checks. COV-E disables reasoning; the advisory judge enables it with an
8,192-token budget. Hosted requests send the question, scoped records,
and saved conversation history to OpenRouter and DeepInfra. See
[OpenRouter trial](docs/openrouter-trial.md) for testing and Cloud setup.

### Local inference

For the Qwen baseline, set `SUPPORT_MODEL_PROVIDER=local` and
`JUDGE_PROVIDER=local` in `.env`. Install `llama-server` on `PATH` (or set
`LLAMA_SERVER`) and place the support model at:

```text
models/customer-support/Qwen_Qwen3-4B-Instruct-2507-Q4_K_M.gguf
```

The [model reference](models/customer-support/README.md) includes its expected
checksum. Model weights are Git-ignored.

`npm run dev` then starts `llama-server` on port 8017, waits for readiness,
and starts the web app. Control-C stops both processes and their children.

## Configuration

The application listens on `127.0.0.1:8016`; local inference uses port 8017.
The launchers read `.env`; shell values take precedence. Unconfigured checkouts
retain the local baseline. `.env.example` selects the hosted trial.

| Variable                      | Purpose                                   | Default                               |
| ----------------------------- | ----------------------------------------- | ------------------------------------- |
| `SUPPORT_MODEL_PROVIDER`      | `local` or `openrouter`                   | `local` when unset                    |
| `OPENROUTER_API_KEY`          | Server-side OpenRouter secret             | No key; required for hosted inference |
| `OPENROUTER_SUPPORT_MODEL`    | Hosted COV-E model ID                     | `deepseek/deepseek-v4.1-flash`        |
| `JUDGE_PROVIDER`              | Independent `local` or `openrouter` judge | `local` when unset                    |
| `OPENROUTER_JUDGE_MODEL`      | Hosted advisory judge model ID            | `deepseek/deepseek-v4.1-flash`        |
| `OPENROUTER_JUDGE_REASONING`  | Hosted judge reasoning, `true` or `false` | `true`                                |
| `OPENROUTER_JUDGE_MAX_TOKENS` | Hosted judge reasoning plus verdict limit | `8192` (range `256`–`32768`)          |
| `CUSTOMER_SUPPORT_MODEL_PATH` | Path to the GGUF model                    | Model path shown above                |
| `LLAMA_SERVER`                | Path or command for the model server      | `llama-server`                        |
| `SITE_URL`                    | Base URL for site metadata                | `http://127.0.0.1:8016`               |

Pass overrides to the launcher:

```sh
CUSTOMER_SUPPORT_MODEL_PATH=/absolute/path/to/model.gguf LLAMA_SERVER=/absolute/path/to/llama-server npm run dev
```

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
| pytest                   | Python judge-adapter and local-only transport tests                   |
| DeepEval                 | Rubric-based response judging with a local Qwen3-14B model            |

Oxlint provides lint checks, TypeScript checks types, and a custom validator checks
the seed dataset.

### Test setup

Install Chromium for browser tests:

```sh
npx playwright install chromium
```

For Python-only tests, install `uv` and prepare the locked environment:

```sh
uv sync --project tools/evaluation --locked
```

This prepares Python 3.12 and its dependencies. No model download or server is needed.

For live model evaluation, also run:

```sh
npm run setup:judge
```

Judge setup prepares the same environment. With `JUDGE_PROVIDER=openrouter`,
it skips model downloads. With `JUDGE_PROVIDER=local`, it downloads the
checksum-verified Qwen3-14B Q4_K_M model (9 GB) to `models/judge/`.
DeepEval telemetry and cloud reporting are disabled in both modes; hosted
judging makes explicitly configured, billed OpenRouter requests.

For local judging, stop the app before running full model evaluations. The runner uses port 8017
sequentially: generate responses with the chatbot, unload its model, then load
the judge. It never stops an externally started server; an occupied port prevents
judge startup. Interrupted runs retain partial evidence.
Hosted generation and judging do not use port 8017. Live suites use the provider
settings in `.env`; ordinary tests never forward the API key or use a hosted model.

### Commands

| Command                 | Runs                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------ |
| `npm test`              | Deterministic unit and integration tests                                                         |
| `npm run test:e2e`      | Production build and browser tests                                                               |
| `npm run test:model`    | Live chatbot factuality tests, repeated sampling, then advisory judging (billed with OpenRouter) |
| `npm run test:judge`    | Selected judge validation against 30 labeled examples (billed with OpenRouter)                   |
| `npm run test:python`   | Judge-adapter unit tests; no model server required                                               |
| `npm run validate:data` | Seed-data validation                                                                             |
| `npm run check`         | Lint, format check, type checks, deterministic tests, seed validation, and build                 |

Browser, Python evaluator, and live-model suites run separately from `npm test`
and `npm run check`.
Database tests use disposable local databases. Browser tests use controlled
model responses.

Run all test suites in sequence (stops if a suite fails):

```sh
npm test && npm run test:python && npm run test:e2e && npm run test:judge && npm run test:model
```

Run individual files or select model tests by name:

```sh
npm test -- tests/integration/orders-api.test.ts
npm run test:e2e -- tests/e2e/checkout.spec.ts
npm run test:model -- -t 'across five samples'
```

Run only the live behavior baseline (attack/control pairs through the chat API):

```sh
npm run test:model -- tests/model/support-behavior-baseline.test.ts
```

Optional evaluation diagnostics:

| Command                                                           | Purpose                                          |
| ----------------------------------------------------------------- | ------------------------------------------------ |
| `npm run test:judge -- --transcript reports/model-runs/<run>.log` | Judge saved samples without regenerating answers |
| `npm run test:judge -- --holdout`                                 | Run the eight originally held-out examples       |
| `npm run test:judge -- --claims-pilot`                            | Check extracted claims from two labeled answers  |
| `npm run test:judge -- --direct-claim-pilot`                      | Check four authored claims without extraction    |

### Organization and results

Tests are grouped under `tests/unit/`, `tests/integration/`, `tests/model/`,
and `tests/e2e/`. Shared data and setup live in `tests/fixtures/`; reusable
response checks live in `tests/assertions/`. Browser tests use
`tests/e2e/pages/` for page objects and `tests/e2e/fixtures/` for setup.
Python judge tests live in `tests/unit/judge-python/`. Authored reference answers
and labeled judge-validation examples live in `tests/fixtures/judge/`.

Command entry points live in `scripts/`, with shared process and model-launch
helpers in `scripts/lib/`. Transcript parsing, judge implementation, model
configuration, and the locked Python project live in `tools/evaluation/`.
The evaluator's virtual environment is Git-ignored.

Model tests check factual accuracy and authorization, with five responses per
repeated-sampling scenario. Factual assertions are mandatory; live judge verdicts
are advisory. Judge-validation label disagreements and execution errors fail
their runs. See [Model evaluation](docs/model-evaluation.md) for methodology,
coverage limits, and validation history. The
[behavior and threat model](docs/genai-behavior-threat-model.md) defines required
chatbot behavior, current controls, and known gaps.

Model transcripts are saved in `reports/model-runs/`. Judge reports and
incremental JSONL evidence are saved in `reports/judge-runs/`.
Browser reports are saved in `playwright-report/`, with failure screenshots
and traces in `test-results/`. These outputs are Git-ignored. View the browser
report with `npx playwright show-report`.

### Demo recordings

`npm run demo:record` records the app workflow with the local model.
`npm run demo:record:tests` records the existing checkout test and generates its
report. Both commands build the app and use disposable databases. Recording
configuration lives in `tools/demo/`; raw videos, traces, and reports are saved
under the Git-ignored `reports/demo-recordings/`. Approved MP4s and thumbnails
live in `docs/media/`.
