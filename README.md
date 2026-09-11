# SABLE Systems Distribution Portal

SABLE Systems is a wholesale supplier and manufacturer serving authorized distributors. Its portal combines
a public-facing brand gateway, an inventory-aware procurement catalog, charge-account checkout, and the
private COV-E customer-support console. COV-E uses the local Qwen3 4B model through `llama-server`
and grounds account-specific answers in a project-local D1/SQLite database.

Primary routes:

- `/` — SABLE marketing and brand identity
- `/shop` — live wholesale inventory, case-pack cart, and charge-account checkout
- `/orders` — authenticated, distributor-scoped order history with search and status filters
- `/support` — private COV-E support with durable per-user incident history

Checkout creates durable orders, order lines, customer-safe events, and account-ledger records.
Physical inventory is reserved atomically and can be exhausted; the server rejects over-allocation,
non-case-pack quantities, duplicate PO references, and requested ship dates in the past.

The seed is deterministic and contains:

- 720 orders from 2021 through 2031
- 648 Calder Pike orders and 72 isolation records split across three other distributors
- one active purchasing user for each distributor, with every order tied to its placing user
- 18 catalog records, including one retired product and one fully quarantined product
- inventory balances, order lines, events, shipments, and returns
- three starter support incidents per user, with later conversations stored in D1

COV-E uses a typed, read-only query router for tenant-scoped order searches,
shipments, returns, charge-account records, support incidents, and catalog or
inventory questions. Other-distributor records are never included in its
authorized context, and the model never receives a database handle or raw SQL
capability.

## Local access

The procurement catalog, ordering API, and COV-E console require a distributor
session. Seed credentials are stored as PBKDF2 hashes; the local access phrases
for the four fictional users are:

| Distributor                       | Email                              | Access phrase     |
| --------------------------------- | ---------------------------------- | ----------------- |
| Calder Pike Distribution          | `mara.venn@calderpike.example`     | `Sable-WHS-0427!` |
| Meridian Civic Supply             | `imani.kade@meridiancivic.example` | `Sable-WHS-1098!` |
| Northline Prosthetics Cooperative | `rowan.sato@northline.example`     | `Sable-WHS-2714!` |
| Halcyon Industrial Exchange       | `lena.orr@halcyonexchange.example` | `Sable-WHS-5830!` |

Sessions use random opaque credentials in an HttpOnly, SameSite cookie and
expire after twelve hours. Signing out revokes the server-side session.

## Run it

```bash
npm run dev
```

Open [http://127.0.0.1:8016](http://127.0.0.1:8016). The command starts the model on port 8017,
waits until it is ready, and then starts the web app. Press Control-C once to stop both processes.

The default model is stored locally in this repository working tree at:

```text
models/customer-support/Qwen_Qwen3-4B-Instruct-2507-Q4_K_M.gguf
```

GGUF model weights are intentionally ignored by Git because of their size. See
`models/customer-support/README.md` for the expected local asset. The launcher
still accepts an explicit model path when needed.

To use a different GGUF or `llama-server` binary:

```bash
CUSTOMER_SUPPORT_MODEL_PATH=/absolute/path/to/model.gguf LLAMA_SERVER=/absolute/path/to/llama-server npm run dev
```

## Local data

Validate the deterministic data contract with:

```bash
npm run validate:data
```

Schema upgrades and fixture changes have separate version markers. Increment
`SCHEMA_VERSION` for migration-backed structure changes; increment
`SEED_VERSION` only when an intentional deterministic fixture rebuild is
required. This keeps orders placed through the application intact during
ordinary schema upgrades.

Model logs are written to `reports/server-logs/llama-server.log`. Local D1 state and generated
runtime files remain under the ignored `.wrangler` directory.

## Testing

Run commands from the repository root after `npm ci`.

| Command                 | What it runs                                                     |
| ----------------------- | ---------------------------------------------------------------- |
| `npm test`              | Deterministic unit and integration tests (Vitest)                |
| `npm run check`         | Those tests, lint, types, seed validation, and production build  |
| `npm run test:e2e`      | Production build and browser workflows (Playwright)              |
| `npm run test:model`    | Real local Qwen evaluations, including repeated sampling         |
| `npm run test:semantic` | Sentence Transformers calibration, or scoring a saved transcript |

**Browser and real-model tests are separate from `npm test` and `npm run check`.**
Database tests use disposable local databases, not development data.

### First-time setup

- Browser tests: `npx playwright install chromium`.
- Model tests: install `llama-server` and provide the [local Qwen model](models/customer-support/README.md). The runner starts it on port 8017 if needed.
- Semantic scoring: install `uv`, then run `npm run setup:semantic`. This downloads the pinned embedding model; subsequent scoring runs offline on the CPU.

### Run a smaller selection

```sh
npm test -- tests/integration/orders-api.test.ts
npm run test:e2e -- tests/e2e/checkout.spec.ts
npm run test:model -- -t 'across five samples'
```

To score existing responses without generating new ones:

```sh
npm run test:semantic -- --scenario case-pack --transcript reports/model-runs/<run>.log
```

Use `--scenario comparison` for the other sampling scenario. Without a transcript,
`test:semantic` runs calibration only.

### Organization

All paths below are relative to `tests/`.

| Location        | Purpose                                                          |
| --------------- | ---------------------------------------------------------------- |
| `unit/`         | Isolated logic; no database, HTTP, browser, or language model    |
| `integration/`  | API, database, concurrency, and filesystem behavior              |
| `model/`        | Real-model factuality and authorization checks                   |
| `e2e/`          | Browser journeys: authentication, support, checkout, and history |
| `e2e/pages/`    | Page objects: selectors and user actions                         |
| `e2e/fixtures/` | Disposable app runtime and page-object setup                     |
| `fixtures/`     | Shared data, identities, setup, and cleanup                      |
| `assertions/`   | Reusable response checks, independent of the app and database    |

Vitest uses a local Worker runtime for app tests and Node for filesystem tests.
No Cloudflare deployment is needed. Browser tests use a fresh local app and
database; only model calls are replaced with controlled responses.

### Adding tests

- Choose the smallest layer that proves the behavior. Add browser journeys for important user flows, not every edge case.
- Keep selectors and interactions in page objects; keep inputs and business assertions in the spec.
- Reuse [API fixtures](tests/fixtures/support-integration.ts), [checkout helpers](tests/fixtures/checkout.ts), and the [browser fixture](tests/e2e/fixtures/app.ts). Clean up test-owned records, sessions, and spies even on failure.
- In browser tests, set `modelReply` or an ordered `modelResponses` sequence. For no model calls, use `test.use({ modelResponses: [[], { scope: 'test' }] })`.
- Prefer locator assertions and observed responses over sleeps. Do not weaken checks or retry failures to obtain a pass.

Keep testing documentation as a usage guide—not a task log, test-by-test inventory, or running list of test counts.

### Model results and evidence

The two repeated-sampling scenarios cover case-pack rules and product comparison.
Each makes five independent requests at normal app settings, without a fixed seed;
every response must pass the factual checks. Five passes are regression evidence,
not a reliability guarantee.

Sentence Transformers automatically scores those samples against authored references.
**Similarity is advisory, not a correctness gate:** correct and incorrect examples
still overlap. Exact factual failures always fail the run, regardless of similarity.

Model transcripts and semantic reports are saved in gitignored `reports/model-runs/`
without overwriting earlier evidence. Browser failures retain traces and screenshots
in `test-results/`; open the browser report with `npx playwright show-report`.
