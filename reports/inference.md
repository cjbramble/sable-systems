# OpenRouter inference

COV-E uses `deepseek/deepseek-v4.1-flash`; its advisory judge uses
`z-ai/glm-5.3-flash`, both through OpenRouter.
Separate model defaults and provider/privacy routing are configured in
`lib/openrouter-config.json`. Model overrides and generation settings remain
separate for chat and judging. Local inference launchers, provider switches,
model downloads, and weights have been removed. Historical results below retain
the evidence that informed this choice; production quality remains unproven.

## Start

The local `.env` was created with a blank `OPENROUTER_API_KEY=` and then filled
in by the user during setup. Run `npm run dev`. A new checkout should first copy
`.env.example` to `.env` and fill in its own key.
The file is Git-ignored. Never put the key in a `VITE_*` or `NEXT_PUBLIC_*`
variable, a browser component, a commit, or a test transcript.

Chat and judging both use OpenRouter, with independent model and generation
settings. Chat pins the DeepInfra FP8 endpoint (`only: ['deepinfra/fp8']`).
The judge lets OpenRouter select a compatible endpoint without a provider pin.
Both prohibit provider fallback and require supported parameters. COV-E disables reasoning
and keeps its 600-token answer budget. The advisory judge enables reasoning
with an 8,192-token limit, raised from 1,024; this total covers both reasoning
and the JSON verdict. They enforce `data_collection: 'deny'`
and `zdr: true`. They omit the seed parameter. Chat model overrides must be available on its pinned endpoint; judge overrides
must support the requested schema, reasoning, and privacy requirements.

The app sends only server-selected authorized records and saved history. It
keeps deterministic incident/no-match replies, authentication, request quotas,
identifier and invented-resource guards, and at most one corrective retry.
Provider failures and missing credentials return safe errors and do not save
an exchange. No automatic switch to a different model is made.

`/api/status` uses the non-generating key endpoint to check credentials and
gateway reachability. It does not establish sufficient credits, inference
capacity, or model quality. A blank key makes it unavailable without a request.

## Run evaluations

Offline checks do not spend credits:

```sh
npm run check # includes offline Python evaluator tests
```

Prepare the judge's Python dependencies:

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
Calibrate a changed judge configuration against the authored labels.

For the same 30 authored examples with reasoning off and on, respectively:

```sh
OPENROUTER_JUDGE_REASONING=false OPENROUTER_JUDGE_MAX_TOKENS=8192 npm run test:judge
OPENROUTER_JUDGE_REASONING=true OPENROUTER_JUDGE_MAX_TOKENS=8192 npm run test:judge
```

Both runs keep the same model, endpoint, rubric, fixtures, temperature, and total
output limit. Each makes 30 billed requests. Shell overrides take precedence
over `.env`. `OPENROUTER_JUDGE_REASONING` accepts `true` or `false` (default
`true`); `OPENROUTER_JUDGE_MAX_TOKENS` accepts integers from 256 to 32768 (default
8192). These settings affect only the judge. A truncated verdict remains
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

This historical comparison used DeepSeek V4.1 Flash, not the current GLM judge.
GLM live calibration began on 2026-09-30; see the current results in
[Model evaluation](model-evaluation.md).

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

Keep judge reasoning enabled and COV-E reasoning disabled. These are
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

## API-only consolidation (2026-09-29)

Removed the local model launch/setup code, model manifests, provider switches,
and both project GGUF files (11,499,033,696 bytes, approximately 11.5 GB). The
app launcher is now `scripts/dev.mjs`; Python judging uses
`tools/evaluation/openrouter_judge.py`. `npm run setup:judge` only installs the
locked Python dependencies. Both adapters read the default model and privacy
routing from `lib/openrouter-config.json`. There is no local inference fallback.
The ignored `.env` retains the configured key and supported model/reasoning
settings; obsolete provider and local-runtime variables have been removed.

Verification after removal:

- `npm run check`: 303 application tests, lint, formatting, type checks, seed
  validation, and production build pass. Local-runtime-only tests were removed;
  process cleanup and interruption tests remain for the app and live-test runner.
- `npm run test:python`: 42 adapter/report tests pass. The network guard rejects
  all connections outside an explicit OpenRouter request, including loopback.
- Production-build browser suite: all 36 tests pass using dummy credentials and
  mocked OpenRouter transport; no inference charges.
- Six live authenticated topic-switch/return-refusal samples pass, with one
  request each and no reasoning tokens. The return record remains unchanged.
- The API-only judge matches all eight selected calibration labels, including
  rejection of the 320-unit stock overclaim. This remains advisory validation.
- Actual development startup returns HTTP 200 for the home page and
  `/api/status` with `ready: true`. The verification server was stopped cleanly.
- The key is absent from the Git diff, client build, and retained verification
  evidence; `.env` remains ignored with owner-only permissions.

Retained live evidence (Git-ignored):

```text
reports/model-runs/2026-09-30T03-15-36-813Z-1dcca493-76e1-4c62-ac48-87643431e57d.log
reports/judge-runs/validation-2026-09-30T03-15-35-891Z-716747ef-62d3-417b-acbb-c7650f2ff9ad.json
```

Historical local transcripts, judge reports, and the existing demonstration
recording are retained as evidence; the README marks that recording as historical.
Current judge reports also hash the shared configuration to detect routing drift.

## Cloud environment

Install Node dependencies with `npm ci`. Set the following environment variables,
and store the key as a secret available to the task runtime:

```text
OPENROUTER_API_KEY=<secret>
OPENROUTER_SUPPORT_MODEL=deepseek/deepseek-v4.1-flash
OPENROUTER_JUDGE_MODEL=z-ai/glm-5.3-flash
OPENROUTER_JUDGE_REASONING=true
OPENROUTER_JUDGE_MAX_TOKENS=8192
```

Allow outbound HTTPS to `openrouter.ai` for live inference. Dependency installation
also needs its package registries. Python setup is needed only for judge tests.
No model downloads, GPU, or local inference service are required.
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

## Managed cloud test runtime (2026-09-30)

The current environment permits OpenRouter HTTPS through its configured HTTP
proxy and supplies the API key as an injected secret. Direct Internet DNS/TCP is
not available. The Python judge honors `HTTPS_PROXY` (or `https_proxy`) with a
CONNECT tunnel to `openrouter.ai:443`, verified TLS, and scoped socket access.
The live Vitest Worker uses a host-side `EnvHttpProxyAgent` bridge for only the
OpenRouter key and completion endpoints. The bridge is enabled only for the
explicit live-model launcher when a proxy is configured; offline tests retain
dummy credentials and mocked responses. Neither transport follows redirects or
disables certificate verification.

Run commands with execution permissions allowing local sockets. This environment
also supplies a child-process subreaper to collect orphaned test descendants;
without it, process-cleanup assertions can fail even after termination. `uv`
needs a cache under a writable root. The setup supplies system Chromium and a
Playwright config selecting `/usr/bin/chromium`. In this managed workspace:

```sh
UV_CACHE_DIR=/workspace/.cache/uv python /workspace/setup/reap.py npm run check
python /workspace/setup/reap.py npx playwright test --config /workspace/sable-playwright.config.mjs
python /workspace/setup/reap.py npm run test:model
python /workspace/setup/reap.py npm run test:judge
```

The wrapper and browser config are environment setup files, not application
requirements for an ordinary development machine. Keep inherited proxy and CA
settings, and keep the API key in its secret binding.
