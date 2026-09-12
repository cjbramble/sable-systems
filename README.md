# SABLE Systems Distribution Portal

A local web application for the fictional SABLE Systems wholesale business.
The portal provides inventory-aware ordering, charge-account checkout, order
history, and COV-E customer support powered by a local Qwen3 4B model.

Built with React, Vinext, and Tailwind CSS, with a Cloudflare Workers backend
and a D1/SQLite database.

## Setup

Requirements:

- Node.js 22.13 or later and npm.
- `llama-server` available on `PATH`, or configured with `LLAMA_SERVER`.
- The Qwen model file listed below.

Install dependencies from the repository root:

```sh
npm ci
```

Place the model at:

```text
models/customer-support/Qwen_Qwen3-4B-Instruct-2507-Q4_K_M.gguf
```

The [model reference](models/customer-support/README.md) includes its expected
checksum. Model weights are Git-ignored.

Start the application:

```sh
npm run dev
```

Open [http://127.0.0.1:8016](http://127.0.0.1:8016). The launcher starts
`llama-server` on port 8017, waits for readiness, then starts the web app.
Press Control-C to stop the model, web app, and their child processes.

## Configuration

The application and model listen on `127.0.0.1`, using ports 8016 and 8017 respectively.

| Variable                      | Purpose                              | Default                 |
| ----------------------------- | ------------------------------------ | ----------------------- |
| `CUSTOMER_SUPPORT_MODEL_PATH` | Path to the GGUF model               | Model path shown above  |
| `LLAMA_SERVER`                | Path or command for the model server | `llama-server`          |
| `SITE_URL`                    | Base URL for site metadata           | `http://127.0.0.1:8016` |

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

These runtime directories are Git-ignored. Empty databases are seeded automatically;
interrupted initialization resumes from the last committed batch. Existing records
are preserved on startup. Schema versions 6 and 7 upgrade to 8 with the current
`SEED_VERSION`.

Unsupported versions or populated databases without version metadata stop startup
without modifying records. Preserve the database and inspect its metadata before
applying a reviewed migration. Changing `SEED_VERSION` does not reset existing data;
rebuilding the dataset requires a separate, explicit reset. Seed statement changes
must update the seed version so unfinished initialization cannot resume with a
different dataset.

## Testing

### Tools

| Tool                     | Role                                                                  |
| ------------------------ | --------------------------------------------------------------------- |
| Vitest                   | Unit, integration, and live-model tests; assertions, mocks, and spies |
| Cloudflare Vitest plugin | Runs Vitest tests in the Workers runtime                              |
| Miniflare                | Local Workers runtime setup and disposable D1 databases               |
| Playwright               | Chromium browser workflows using page objects                         |
| Sentence Transformers    | Advisory response-similarity scoring with `all-MiniLM-L6-v2`          |

Oxlint provides lint checks, TypeScript checks types, and a custom validator checks
the seed dataset.

### Test setup

Install Chromium for browser tests:

```sh
npx playwright install chromium
```

For semantic scoring and the full live-model suite, install `uv` and run:

```sh
npm run setup:semantic
```

Semantic setup provisions the Python 3.12 environment and downloads the pinned
embedding model. Scoring runs locally on the CPU. Live-model tests use the
configured Qwen model; the runner starts `llama-server` on port 8017 when needed.
An already-running model server is left running. Interrupted runs retain their
partial transcript.

### Commands

| Command                 | Runs                                                                          |
| ----------------------- | ----------------------------------------------------------------------------- |
| `npm test`              | Deterministic unit and integration tests                                      |
| `npm run test:e2e`      | Production build and browser tests                                            |
| `npm run test:model`    | Live Qwen evaluations, including repeated sampling and semantic scoring       |
| `npm run test:semantic` | Semantic calibration or scoring of a saved transcript                         |
| `npm run validate:data` | Seed-data validation                                                          |
| `npm run check`         | Lint, type checks, deterministic tests, seed validation, and production build |

Browser and live-model suites run separately from `npm test` and `npm run check`.
Database tests use disposable local databases. Browser tests use controlled
model responses.

Run individual files or select model tests by name:

```sh
npm test -- tests/integration/orders-api.test.ts
npm run test:e2e -- tests/e2e/checkout.spec.ts
npm run test:model -- -t 'across five samples'
```

Score a saved transcript using the `case-pack` or `comparison` scenario:

```sh
npm run test:semantic -- --scenario case-pack --transcript reports/model-runs/<run>.log
```

### Organization and results

Tests are grouped under `tests/unit/`, `tests/integration/`, `tests/model/`,
and `tests/e2e/`. Shared data and setup live in `tests/fixtures/`; reusable
response checks live in `tests/assertions/`. Browser tests use
`tests/e2e/pages/` for page objects and `tests/e2e/fixtures/` for setup.

Model tests check factual accuracy and authorization. Repeated-sampling tests
evaluate five responses per scenario at normal generation settings. Semantic
scores are advisory; factual assertions determine response correctness.

Model transcripts and semantic reports are saved in `reports/model-runs/`.
Browser reports are saved in `playwright-report/`, with failure screenshots
and traces in `test-results/`. These outputs are Git-ignored. View the browser
report with `npx playwright show-report`.
