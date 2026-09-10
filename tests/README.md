# Test organization

- `unit/**/*.test.ts`: isolated tests that do not use D1, HTTP, a browser, or a language model.
- `integration/**/*.test.ts`: deterministic tests across application boundaries, including Miniflare and D1.
- `model/**/*.test.ts`: fixed-input evaluations that invoke the local support model through `npm run test:model`.
- `e2e/**/*.spec.ts`: Playwright browser workflows, separate from Vitest and local-model evaluations.
- `e2e/pages/`: page objects that own browser selectors and user actions; business assertions stay in the specs.
- `e2e/fixtures/`: browser-specific setup, including the disposable application runtime and page-object instances.
- `fixtures/`: shared test data, test-only identities, and setup/cleanup helpers; it contains no test cases.

Keep model evaluations separate from the default deterministic suite. Do not create an empty category directory before its first test is added.

Run deterministic checks with `npm test` and the full local model suite with
`npm run test:model`. The model runner also forwards Vitest filters, for example:

```sh
npm run test:model -- -t 'reports only authorized facts for an exact return'
```

Model assertions inspect the raw generated response; the API's identifier safety
check does not repair or mask model-evaluation failures.

The read-only model scenario requests an order cancellation and a return
authorization using fixed seeds. It requires an explicit capability limitation,
rejects first-person and passive completion claims, and compares complete,
stably ordered business-table snapshots after each request (even on failure).
Like the other model cases, it exercises the real context builder and local
model, not the chat API's persistence path. Its phrase-based checks are targeted
regression coverage, not a general semantic evaluator of every possible reply.

The existing invalid-case-pack model case distinguishes stock availability from
ordering eligibility. It requires an ordering restriction or quantity adjustment
and rejects affirmative partial-unit fulfillment promises, while allowing an
explicit refusal of those exceptions (including "No partial units can be
shipped"). A refusal must not hide a later contradictory promise. These remain
targeted phrase checks, not a general interpretation of every possible reply.
The catalog integration test also checks
that the model receives the applicable restriction from the context builder.

The repeated-sampling case asks that same question five independent times using
the application's normal generation settings (currently temperature 0.35,
top-p 0.9, up to 600 tokens, no fixed seed). The prompt and authorized context
stay identical; previous replies are not added to history. All five samples
must satisfy the same factual and case-pack checks as the fixed-seed regression.
Failures are collected so later samples still run, with no retries or
majority-vote acceptance. Inference/response-format failures are distinguished
from factuality assertion failures. Identical wording is allowed, not required.
Five samples are bounded regression evidence, not a reliability estimate or a
guarantee about every possible answer.

Run only this scenario with:

```sh
npm run test:model -- -t 'preserves case-pack facts across five samples'
```

When `npm run test:model` starts Vitest, it saves test output to a new, gitignored
`reports/model-runs/<timestamp>-<unique-id>.log` file and prints its location.
The sampling case records the actual request/settings/context and each raw
response, extracted answer, and verdict. Passing samples and failures are both
retained; subsequent runs never overwrite previous evidence. Use the script
rather than invoking Vitest directly when retained evidence is needed.
The runner owns verbose console capture; custom reporters and `--silent` are
rejected so they cannot silently disable semantic scoring. Test-name filters
remain supported.

## Local Sentence Transformers evaluation

The model-test runner now scores the five case-pack replies with the actual
Python [Sentence Transformers](https://www.sbert.net/docs/sentence_transformer/usage/semantic_textual_similarity.html)
library and a separate local
[all-MiniLM-L6-v2](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2)
embedding model. It runs as a CPU subprocess after Vitest, not as a server,
browser dependency, or replacement for Qwen. No additional port is needed.

One-time setup requires `uv`, which selects Python 3.12 for this isolated project:

```sh
npm run setup:semantic
```

Dependencies are pinned in `scripts/semantic/pyproject.toml` and `uv.lock`.
Setup downloads only the files listed in `scripts/semantic/model.json`, from
its pinned Hugging Face revision, into ignored `models/semantic/`. The local
virtual environment and model weights are not committed. Tests use local-only,
offline loading, safetensors, and no remote model code; a missing model/runtime
or changed model-file receipt fails evaluation rather than silently skipping it.
Keep the generated dependency lockfile and the model manifest committed.

`npm run test:model` automatically adds a sibling `.semantic.json` report when
the case-pack sampling scenario runs. Filtered tests without that scenario do
not require Sentence Transformers. `npm test` remains model-free. Every semantic
report records model/file hashes, package versions, evaluator and reference-set
hashes, the source transcript hash, per-reference cosine scores, pairwise reply
similarities, calibration results, and the original factual verdicts. Responses
over the encoder token limit are scored in complete token chunks, pooled by
token count and normalized; the report includes chunk counts. No answer suffix
is silently discarded.

Run calibration alone, or score retained answers without generating new ones:

```sh
npm run test:semantic
npm run test:semantic -- --transcript reports/model-runs/<run>.log
```

Each completed scoring run writes a new report; existing evidence is never
overwritten. Replaying a transcript with any failed factual sample still exits
with failure, even when its similarity score is high. An inference failure with
no answer is explicitly listed as unscored, not given a synthetic passing score.

### What the scores mean

The versioned fixture contains two authored reference answers, six labeled
calibration examples, and four separate holdout examples. Examples include
valid paraphrases, wrong quantities, negated permissions, and an unrelated
answer. These are a small authored set, not a validated general benchmark.
The metric is the maximum cosine similarity to either reference. It measures
resemblance, not the probability that an answer is correct.

Calibration currently overlaps: an incorrect stock answer scored about 0.983,
while a correct paraphrase scored about 0.745. Therefore **semantic scores are
advisory, not a pass/fail correctness gate**. No threshold was lowered to obtain
passing answers. The report proposes a diagnostic midpoint only if calibration
labels separate, and checks it on holdout examples; even then enforcement needs
separate review. Exact factual/business-rule failures always fail the run.
Missing, incomplete, or malformed evaluator results also fail the run.

Known factual-coverage gap: sampled replies have called 304 the nearest valid
case-pack quantity to 310, although 312 is closer. The existing assertions do not
yet check that arithmetic. A passing run does not mean every claim was verified;
nearest-quantity regression coverage is the next test to add.

## API response fixtures

API response tests use `fixtures/support-api.ts` for real test sessions, fresh
mock model responses, direct database snapshots, and scoped cleanup. Create a
fixture per test and call `cleanup()` in `finally`, including around setup.
Register temporary incidents before creating them; registration refuses existing
records. Reading a seeded incident does not register it for deletion. Keep request
bodies, expected results, and assertions in the test rather than in the fixture.

## Browser workflows

Install the pinned dependencies with `npm ci`, then install the browser once:

```sh
npx playwright install chromium
```

Run the browser suite with `npm run test:e2e`. This builds the production app
before running Playwright, so tests cannot silently use a stale build. Filters
are forwarded, for example:

```sh
npm run test:e2e -- --grep 'sends and reopens'
```

Each test gets a fresh Miniflare worker, disposable D1 database, and browser
context. The worker binds to loopback on an OS-assigned temporary port; it never
uses the development server, its `.wrangler` database, or reserved ports
8016/8017. The app seeds the test database through its normal initialization and
the test signs in through the real login form using a seeded local-only account.
The fixture disposes the worker and database even after failure.

Only outbound model/status requests are replaced with controlled replies;
unexpected worker outbound requests are blocked and fail the test. Browser
requests to login, support, and database-backed APIs are not mocked. These tests
check application behavior, not Qwen's response quality. `npm test` and
`npm run check` continue to run the deterministic unit/integration suite;
`npm run test:model` remains the separate real-model evaluation command.

Use `modelReply` for a fixed successful reply. For a failure/recovery workflow,
set `modelResponses` to an ordered list of `{ status, body }` values in a scoped
`test.describe` block. Array-valued [fixture options](https://playwright.dev/docs/test-fixtures)
need the long-form wrapper: `test.use({ modelResponses: [responses, { scope: 'test' }] })`.
The fixture copies that list for each test;
model-status polling does not consume it. Extra completion requests beyond the
configured sequence are blocked and fail the test, never sent to the real model.

`LoginPage` and `SupportPage` encapsulate selectors and interactions, following
the [Playwright page-object pattern](https://playwright.dev/docs/pom). Keep
scenario-specific inputs, expected responses, and database assertions in the
spec. `SupportMessage` is a message-scoped page component for inspecting formatted
replies; it keeps Markdown/HTML selectors out of scenarios and works after reload.
The rendering scenario uses harmless, local-only script probes and checks both
new and persisted replies. It is targeted regression coverage, not a complete
security audit. Prefer locator assertions and observed responses over fixed
sleeps. The suite uses Chromium with one worker and no retries; traces and screenshots are
retained on failure in ignored `test-results/`, with an HTML report in ignored
`playwright-report/` (`npx playwright show-report` opens it).
