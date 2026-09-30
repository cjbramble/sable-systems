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
with reasoning enabled and an
8,192-token budget. Hosted requests send the question, scoped records,
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
| `OPENROUTER_JUDGE_MAX_TOKENS` | Hosted judge reasoning plus verdict limit | `8192` (range `256`–`32768`)          |
| `SITE_URL`                    | Base URL for site metadata                | `http://127.0.0.1:8016`               |

The chat and judge defaults and provider/privacy policies are configured separately
in `lib/openrouter-config.json`. COV-E uses an 8,192-token prompt
budget with a 600-token reply limit and reasoning disabled. The judge uses
reasoning and an 8,192-token completion limit. Chat model overrides must be supported by the pinned DeepInfra FP8 endpoint.
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

### DeepEval improvement phases

The GLM judge remains advisory. Offline adapter tests establish harness behavior,
not GLM judgment accuracy. Historical DeepSeek results do not validate GLM.

| Phase                                  | Implemented                                                                                                                                                           | Remaining validation                                                                                  |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 1: coverage and benchmark              | 36 support/injection/completeness controls with independent grading dimensions; separate eight-case benchmark candidate with a freeze manifest                        | One completeness disagreement; independent human review of labels remains pending                     |
| 2: harness and reporting               | Planned/processed coverage, per-scenario false acceptances/rejections and errors, separate success fields, bounded redacted failure evidence, Python tests in `check` | Current application checks: 304 tests and 124 Python tests pass                                       |
| 3: claim diagnostics and qualification | 16 direct-verdict controls; 26 extraction cases with 40 expected source claims and separate coverage/truth results                                                    | Three frozen runs completed; human semantic review of labels, claims and explanations remains pending |

Expanded support cases cover orders, shipments, returns, account authorization,
missing records, compound requests, topic switches and action refusals. Evaluator
injection controls place attacks in the question, answer and quoted source text,
with correct-answer and benign-quotation controls. These synthetic fixtures test
judging; they do not expand the live chatbot transcript parser, which still
judges only case-pack and comparison samples.

After configuring credentials, each command below makes billed requests:

```sh
npm run test:judge -- --suite coverage   # 36 structured dimensional judgments
npm run test:judge -- --suite benchmark  # 8 original frozen GEval judgments; review labels first
npm run test:judge -- --suite claims     # 16 direct verdict calls
npm run test:judge -- --suite extraction # 26 extractions plus one call per extracted quote
```

The default command regrades the original 30 calibration labels with the revised
assessment. Non-benchmark runs use `evaluate_support.py`; the frozen benchmark
uses unchanged `evaluate.py` and its original GEval rubric.
Add `--concurrency 2` or `--concurrency 4` for bounded parallel revised grading;
the default is sequential, and the benchmark remains sequential. `--holdout`
selects eight reused regression cases, not an untouched benchmark. Suite flags
cannot be combined with transcript, holdout or pilot flags. GLM live runs began on 2026-09-30; the eight-case candidate matched all eight
labels in each of three runs. Independent human review remains pending. Review the [evaluation protocol](docs/model-evaluation.md#qualification-protocol)
before drawing conclusions from them.

### Original verification (2026-09-30)

- `npm run check`: 304 application tests and 63 Python tests passed, plus lint,
  formatting, types, seed validation and build.
- Chromium: 36/36 tests passed. Live chatbot: 48/48 tests passed after fixing a
  nearest-quantity assertion false positive; all ten retained samples were
  accepted by GLM.
- GLM label agreement: original calibration 30/30; coverage 23/24; direct claims
  13/14; extraction 14/14; legacy pilots 2/2 and 4/4. The frozen candidate matched
  8/8 in each of three unchanged runs.

The original grading runs had two disagreements with authored expectations:
correct stock plus appended injection text was rejected as off-topic, and an
unsupported delivery date received `idk` rather than the expected `no`. Labels
and the rubric were preserved for independent review. See
[retained results and limitations](docs/model-evaluation.md#glm-verification-2026-09-30).
GLM remains advisory; repeated agreement does not replace human review.

### Corrective grading revision

Support answers now have independent factual-support, requested-information
coverage, and customer-facing quality assessments. Every factual claim and
requested field retains its own verdict and explanation. An overall pass
requires all three dimensions; unsupported claims (`idk`) and contradictions
(`no`) both fail factual support. Correct stock with appended evaluator
manipulation passes stock support but fails answer quality. A faithful answer
that omits a requested field fails completeness. Benign requested quotations
remain allowed. Calibration reports require expected dimension agreement as
well as overall label agreement, so one defect cannot mask another.

`coverage-v2.json` and `claim-controls-v2.json` record the revised calibration
expectations and their rationales, including an unsupported-date `idk` control
and a recorded-date `no` control. The original fixtures, failed reports, both
models, and frozen benchmark files remain unchanged. Claim response schemas
require exactly one verdict; missing or duplicate verdicts remain errors.
Corrected coverage matches 26/26 overall labels and 25/26 full dimension
expectations, with zero false acceptances, false rejections or execution errors.
Legacy calibration matches all 30 original labels with no execution errors.
One completeness disagreement remains for an invented escalation response; it
is rejected on facts and quality. At that revision, direct claims and extraction each matched 16/16.
Live corrective verification results are recorded in
[Model evaluation](docs/model-evaluation.md#corrective-grading-revision).

### Checking claim extraction

The extraction suite now checks whether all 40 expected claims appear in the
quotes extracted from its 26 answers. It lists missing claims, quotes that are
not in the answer, and extracted text outside the expected claim list. Truth
checks run separately, so a correct overall verdict cannot hide a missed claim.
API failures leave claims unassessed and fail the run.

The extractor copies source text rather than paraphrasing it. A longer quote can
cover several expected claims. Expected claims and labels are not sent to the
model. The controls include appended false claims, contradictions, negation,
policy exceptions, product prices, claimed actions, courtesy, and extractor
injection. A faithful answer that omits requested information remains distinct
from an extractor that omits information actually present in the answer.

Run `npm run test:judge -- --suite extraction --concurrency 4` after configuring
the API key. This uses the existing GLM judge and makes billed requests.
The live run covered 40/40 expected claims and matched all 26 truth labels,
with no execution errors, missing claims or non-source quotes. Human review
of the authored claim lists is still needed. See
[claim extraction coverage](docs/model-evaluation.md#claim-extraction-coverage)
for results and limits.

### Completeness of action responses

The current answer rules judge each requested action and information field
separately. A safe refusal answers an action request. A proposed route or claimed
completion also addresses that request, even when it is false; facts and answer
quality reject invented routes and unauthorized actions. Saying nothing about a
requested item fails completeness. A recorded status alone does not answer a
request to change it.

`coverage-v3.json` preserves all 26 prior expected outcomes and adds ten action
response controls. It includes a refusal of only one requested action, a missing
requested status, false completion claims, invented routes, and a recorded request
route. Factual assessments now quote the answer itself; plain advice is not treated
as an assertion of a record error, and omitted reference facts cannot enter the
assessment. The ordinary answer rules are version 6; claim verification and extraction
retain their existing rules. See [action-response completeness](docs/model-evaluation.md#action-response-completeness)
for the exact cases and live results.

For the managed cloud runtime, see the [proxy, Chromium and process-reaping setup](docs/inference.md#managed-cloud-test-runtime-2026-09-30).

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

Command entry points live in `scripts/`, with shared process and environment
helpers in `scripts/lib/`. Transcript parsing, judge implementation, and the locked Python project live in `tools/evaluation/`.
Shared model and provider configuration lives in `lib/openrouter-config.json`.
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

`npm run demo:record` records the app workflow with live OpenRouter inference
and incurs API charges.
`npm run demo:record:tests` records the existing checkout test and generates its
report. Both commands build the app and use disposable databases. Recording
configuration lives in `tools/demo/`; raw videos, traces, and reports are saved
under the Git-ignored `reports/demo-recordings/`. Approved MP4s and thumbnails
live in `docs/media/`.
