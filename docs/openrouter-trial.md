# OpenRouter trial

This branch prepares COV-E and its independently configured advisory judge for
`deepseek/deepseek-v4.1-flash` through OpenRouter. Initial verification is recorded
below; broader production quality remains unproven.
The previous local fixes are on `main` at `186a6e2`.

## Start

The local `.env` was created with a blank `OPENROUTER_API_KEY=` and then filled
in by the user during setup. Run `npm run dev`. A new checkout should first copy
`.env.example` to `.env` and fill in its own key.
The file is Git-ignored. Never put the key in a `VITE_*` or `NEXT_PUBLIC_*`
variable, a browser component, a commit, or a test transcript.

Chat and judging both select OpenRouter in the example file. The two provider
and model settings are independent; local mode remains available for comparison.
Both hosted defaults pin the DeepInfra FP8 endpoint (`only: ['deepinfra/fp8']`), prohibit
provider fallback, and require supported parameters. COV-E disables reasoning
and keeps its 600-token answer budget. The advisory judge enables reasoning
with an 8,192-token limit, raised from 1,024; this total covers both reasoning
and the JSON verdict. They enforce `data_collection: 'deny'`
and `zdr: true`. For consistency across hosted routes, they omit the local seed
parameter. Hosted model overrides must be available on that pinned endpoint.

The app sends only server-selected authorized records and saved history. It
keeps deterministic incident/no-match replies, authentication, request quotas,
identifier and invented-resource guards, and at most one corrective retry.
Provider failures and missing credentials return safe errors and do not save
an exchange. No automatic switch to a different model is made.

`/api/status` uses the non-generating key endpoint to check credentials and
gateway reachability. It does not establish sufficient credits, inference
capacity, or model quality. A blank key makes it unavailable without a request.

## Run the experiment

Offline checks do not spend credits:

```sh
npm run check
npm run test:python
```

Prepare the judge's Python dependencies. With the hosted judge selected,
setup does not download model weights:

```sh
npm run setup:judge
```

Once a key is configured, these commands make billed inference requests:

```sh
# Narrow first pass: repeated authenticated topic-switch and refusal checks.
npm run test:model -- tests/model/support-response-fixes.test.ts
# Calibrate the judge against independently labeled answers.
npm run test:judge
# Full existing factual/security suite plus advisory judging of retained samples.
npm run test:model
```

Retain the original outputs and failures. Do not change references or lower
thresholds to fit hosted answers. Factual assertions remain mandatory; judge
verdicts remain advisory, especially when the same model generates and judges.
The new judge needs its own calibration against the authored labels.

For the same 30 authored examples with reasoning off and on, respectively:

```sh
OPENROUTER_JUDGE_REASONING=false OPENROUTER_JUDGE_MAX_TOKENS=8192 npm run test:judge
OPENROUTER_JUDGE_REASONING=true OPENROUTER_JUDGE_MAX_TOKENS=8192 npm run test:judge
```

Both runs keep the same model, endpoint, rubric, fixtures, temperature, and total
output limit. Each makes 30 billed requests. Shell overrides take precedence
over `.env`. `OPENROUTER_JUDGE_REASONING` accepts `true` or `false` (default
`true`); `OPENROUTER_JUDGE_MAX_TOKENS` accepts integers from 256 to 32768 (default
8192). These settings affect only the hosted judge. A truncated verdict remains
an execution error; its response is retained instead of being treated as a pass.

Transcripts are saved under `reports/model-runs/`; judge JSON/JSONL reports
under `reports/judge-runs/` retain provider/model metadata, requests and
responses, including OpenRouter's token usage and cost when supplied. Headers
and the API key are excluded. These files are Git-ignored and may contain
support data. Corrective retries and judge calls add to billed usage. Set a
spending limit on the OpenRouter key before running larger suites.

## Initial verification (2026-09-29)

- Offline application checks: 316 tests, lint, formatting, type checks, seed
  validation, and production build pass. Python adapter/report tests: 36 pass.
  Affected support-history and status browser scenarios: 6 pass.
- Startup: the local home page returns HTTP 200 and `/api/status` reports ready.
  The actual key is absent from the client build; `.env` remains ignored with
  owner-only file permissions.
- The first six-sample smoke run was rejected before inference: the DeepSeek
  endpoint violated this account's training and zero-retention settings. The
  rejected transcript is retained. Pinning DeepInfra FP8 with explicit training
  denial and ZDR passed all six samples, without corrective retries. Observed
  API response times were 0.437–0.875 seconds; reported inference cost totaled
  $0.0003078936, excluding platform fees.
- The full suite initially passed 47/48 tests. All 46 repeated API/case-pack/
  comparison samples passed. The remaining test rejected a correct answer:
  “minimum block is 25 seats” plus an explicit whole-pack multiple and valid
  50/75-seat adjustments. Its assertion now accepts that equivalent rule while
  rejecting a minimum alone, wrong increments, and contradictory blocks, with
  separate authored controls using 12-seat blocks. The one affected live test
  passed its targeted rerun. No model prompt or authored reference was changed.
- With reasoning disabled and the original 1,024-token limit, the hosted judge
  returned valid structured responses, accepted all 10 retained
  case-pack/comparison samples, and matched 7/8 frozen holdout labels. It wrongly
  accepted `holdout-unavailable-alternative`, recommending 320 units despite
  only 312 being available. The calibration command therefore exits with failure;
  that result is preserved and the judge remains advisory.

Retained, Git-ignored evidence:

```text
reports/model-runs/2026-09-30T01-08-04-651Z-045f59ef-a250-482d-836c-722f3c67620f.log
reports/model-runs/2026-09-30T01-09-59-807Z-f6b607f6-64b5-4d96-a8ea-52a5a5eb7a23.log
reports/model-runs/2026-09-30T01-11-25-587Z-8bb1e158-c922-4727-9a29-2b7ca420f338.log
reports/model-runs/2026-09-30T01-15-33-672Z-cdfdfff5-35e1-4f5c-b141-ec546496a68e.log
reports/judge-runs/validation-2026-09-30T01-11-05-117Z-f6ef9a5b-be9e-41cb-a164-8c338b8c31f7.json
reports/judge-runs/transcript-2026-09-30T01-12-12-196Z-d6536b08-2744-43df-8d26-34abc72e26ca.json
```

## Judge reasoning comparison (2026-09-29)

One run per setting judged all 30 authored examples (15 correct and 15
incorrect). The paired requests had identical prompts, references, labels,
schemas, model, routing, temperature 0, and 8,192-token limits; only the
`reasoning.enabled` setting differed. Fixture, rubric, and evaluator hashes
also matched. Each example used one request, without retries.

| Judge reasoning | Label agreement | False acceptances | False rejections | Execution errors | Median seconds | Reported inference cost, 30 calls |
| --------------- | --------------- | ----------------- | ---------------- | ---------------- | -------------- | --------------------------------- |
| Off             | 28/30           | 1                 | 1                | 0                | 1.04           | $0.0019197920                     |
| On              | 30/30           | 0                 | 0                | 0                | 12.85          | $0.0062500984                     |

Without reasoning, the judge rejected `valid-rule-first` by demanding a
redundant stock-shortfall statement, and accepted `holdout-unavailable-alternative`
despite its promise to supply 320 units from only 312 in stock. Reasoning
corrected both verdicts and explicitly identified the stock contradiction.
The off run exits 1 for label disagreement; the on run exits 0. Neither had
transport, schema, or truncation errors.

The reasoning run used 11,315 completion tokens, including 9,336 reasoning
tokens; the largest individual completion was 749 tokens. The off run used
1,720 completion tokens and no reasoning tokens. Thus this run did not approach
the raised limit; 8,192 provides headroom for harder judgments. Raising a cap
does not itself consume that many tokens.

Keep hosted judge reasoning enabled and COV-E reasoning disabled. These are
reused calibration examples and one observation per setting, so 30/30 does not
establish general judge accuracy or qualify it as a gate. The measured costs
come from response usage and exclude platform fees. Timing and prompt-cache
usage can vary; the off run preceded the on run.

Offline verification: `npm run check` passes all 316 application tests, lint,
formatting, type checks, seed validation, and the production build. All 43
Python adapter/report tests pass, including configuration validation, unchanged
local settings, and retained evidence for a truncated verdict. The configured
key is absent from the Git diff and client build; `.env` remains ignored and
has owner-only permissions.

Retained, Git-ignored comparison reports:

```text
reports/judge-runs/validation-2026-09-30T02-08-39-787Z-3c6459bb-338b-4008-9e80-69f0f992cee5.json
reports/judge-runs/validation-2026-09-30T02-09-35-791Z-3715f2dc-8ea1-4245-bb7a-56a4dd95342a.json
```

## Cloud environment

Install Node dependencies with `npm ci`. Set the following environment variables,
and store the key as a secret available to the task runtime:

```text
SUPPORT_MODEL_PROVIDER=openrouter
OPENROUTER_API_KEY=<secret>
OPENROUTER_SUPPORT_MODEL=deepseek/deepseek-v4.1-flash
JUDGE_PROVIDER=openrouter
OPENROUTER_JUDGE_MODEL=deepseek/deepseek-v4.1-flash
OPENROUTER_JUDGE_REASONING=true
OPENROUTER_JUDGE_MAX_TOKENS=8192
```

Allow outbound HTTPS to `openrouter.ai` for live inference. Dependency installation
also needs its package registries. Python setup is needed only for judge tests.
No model downloads, GPU, or inference service on port 8017 are required.
`npm run check` and mocked tests work without the key; live tests need it in
their runtime, not solely in an environment's installation phase.

Builds disable the published demo accounts. For local production-preview tests,
`npm start` explicitly enables them and binds to loopback. Public deployment
still needs private account provisioning and its own access policy.

## Data and provider boundaries

Hosted inference sends customer questions, scoped records, and conversation
history to OpenRouter and DeepInfra. The current seed is fictional. Before using
real customer data, review both services' retention/training terms and configure
the OpenRouter account's privacy restrictions. Those restrictions may make the
pinned provider unavailable; the app fails instead of choosing another provider.

Primary references used to configure the adapter:

- [Model and provider metadata](https://openrouter.ai/api/v1/models/deepseek/deepseek-v4.1-flash/endpoints)
- [Chat completions and authentication](https://openrouter.ai/docs/api/reference/overview)
- [Provider routing](https://openrouter.ai/docs/guides/routing/provider-selection)
- [Reasoning controls](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)
- [Provider privacy](https://openrouter.ai/docs/guides/privacy/provider-logging)
