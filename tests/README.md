# Test organization

- `unit/**/*.test.ts`: isolated tests that do not use D1, HTTP, a browser, or a language model.
- `integration/**/*.test.ts`: deterministic tests across application boundaries, including Miniflare and D1.
- `model/**/*.test.ts`: fixed-input evaluations that invoke the local support model through `npm run test:model`.
- `e2e/**/*.spec.ts`: Playwright browser workflows, separate from Vitest and local-model evaluations.
- `e2e/pages/`: page objects that own browser selectors and user actions; business assertions stay in the specs.
- `e2e/fixtures/`: browser-specific setup, including the disposable application runtime and page-object instances.
- `fixtures/`: shared test data, test-only identities, and setup/cleanup helpers; it contains no test cases.
- `assertions/`: test-only response checks shared by deterministic checker tests and live-model evaluations; no application or database dependencies.

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

The fixed-seed and repeated-sampling case-pack checks now also validate explicit
nearest/closest quantity claims using `assertions/nearest-case-pack.ts`. For 310
units and packs of 8, 312 is 2 units away; 304 is 6 units away. Naming 304 as a
valid alternative or the nearest lower quantity is allowed, but calling it
nearest without that qualifier fails. A list described as nearest must contain
only nearest quantities; ties are accepted when genuinely equidistant.

This is targeted phrase coverage (quantity-first statements, nearest-first
statements, parenthetical examples, and nearest-quantity list headings), not a
general language judge. It does
not require an unsolicited nearest-quantity claim or validate every arithmetic
statement. The deterministic checker regression covers incorrect quantities,
valid alternatives, direction qualifiers, ties, and scoped negation. Rechecking
saved replies preserves the original transcripts and semantic scores rather
than changing their recorded verdicts. The original five replies failed this
check when re-evaluated; their evidence remains unchanged.

The authorized physical-product context now calculates both adjacent positive
case-pack multiples, their distances, their current stock shortfalls (if any),
and which quantity or tied quantities are nearest. Zero is never suggested as
an order quantity. This runs only for an invalid case-pack request; valid
quantities and digital-license allocation behavior are unchanged. The
database-backed regression checks lower/upper choices, ties, below-one-case
requests, a nearest quantity beyond available stock, and a second product's
different case size. These calculations do not place or change orders.

The first post-change model run (2026-09-10T04:18:32Z) selected 312 as nearest in
the fixed-seed reply and all five normal-generation replies, but it is **not a
clean model pass**: one of three selected tests passed and two failed. Retained
evidence identifies these follow-ups, without altering assertions or resampling:

- Sample 5 uses a bulleted "Valid nearest quantities" heading for both 304 and
  312 before correctly selecting 312. A deterministic regression now catches
  that contradictory heading/list form when the retained reply is rechecked.
  This fixes the checker gap, not the model's contradictory response.
- The fixed-seed reply and samples 2–4 were rejected because the old shortfall
  pattern matched "shortfall: 310" in an ordering-restriction explanation.
  `assertions/stock-shortfall.ts` now distinguishes that requested-quantity
  subject from a positive shortage amount. A deterministic regression covers
  those explanations alongside genuine shortages and contradictory claims.
- Separately, the new second-product check exposed a product-name collision:
  "Coldstart Rack Controller R2" can select Blackchannel Haptic Controller via
  a shared search term. This arithmetic test uses the exact item number
  `SBL-CSR-R2`; product-match precedence remains an unfixed routing issue.

The run transcript and semantic report share the prefix
`reports/model-runs/2026-09-10T04-18-32-239Z-71fd1c54-7e8d-4bee-9f0f-651cc27b5eb1`.
Semantic scores remain advisory and do not override the failed verdicts.

The nearest-list checker supports plain, emphasized, and Markdown headings;
unordered and numbered lists; and indented child items. Only direct quantity
items inherit the heading's nearest/lower/higher meaning. Nested explanation
items, sibling lists, and later sections do not inherit it. A subsequent correct
nearest claim does not erase an earlier contradictory list. List numbering and
case-count annotations are not treated as quantities. This is bounded Markdown
coverage, not a complete Markdown parser or a general factuality guarantee.

The shortfall check makes a narrow exception for a colon label followed by the
actual requested quantity, an explicit ordering-restriction predicate and
reason, and no stock-deficit wording in the same clause. It also recognizes
locally negated shortage claims and quantified forms such as "8 units short"
and "short by 8 units". Neither a valid ordering explanation nor a negation
exempts another positive shortage or "out of stock" claim elsewhere. This is
targeted phrase coverage, not a general language judge.

The saved-response replay on 2026-09-10T04:43:09Z clears the shortfall false
positives for the fixed-seed reply and samples 2–4. All five sampled replies
clear the shortfall checker, but sample 5 still fails the nearest-list checker.
The saved 320-unit request's real 8-unit shortage remains detectable as a
positive control. The separate ignored `.shortfall-replay.json` report records
the source and checker hashes; the original transcript, verdicts, and semantic
scores are untouched. This replay covers these two checkers only, not every
model assertion, and does not generate new responses. `npm run check` passed
124 deterministic tests at that milestone; the historical model run remains failed.

The authorized context now explicitly labels the closest choice and identifies
the farther quantity as a valid alternative, not another nearest quantity. It
directs a list containing both to use "Valid alternatives"; genuinely tied
quantities can both be described as nearest. A new database-backed regression
covers the nearer lower/higher choices, ties, below-one-case requests, a nearest
choice beyond stock, another product's case size, and no adjustment guidance
for an already-valid quantity. The arithmetic, stock values, model settings,
and factual checkers were unchanged at that milestone. `npm run check` passed
125 deterministic tests.

One fresh targeted run (2026-09-10T04:57:31Z) passed both fixed-seed quantity
cases but failed the five-sample test: **2 tests passed, 1 failed, 26 skipped**.
All five samples correctly distinguish 312 as nearest from the valid 304
alternative. This is bounded evidence, not a guarantee about future replies.
Only samples 2 and 3 passed every assertion. The retained failures are:

- Sample 1 genuinely invents a stock shortfall: it says 310 requested exceeds
  312 available by 2 units. The existing shortfall checker correctly rejects it.
- Sample 4 says "Stock shortfall: 310 units is not a multiple of 8." This is a
  case-pack explanation, not a shortage claim, but the predicate check at the
  time did not recognize this wording and falsely rejected it.
- Sample 5 says "no partial units or broken cases are permitted." The existing
  fulfillment checker matches "broken cases are permitted" without carrying
  the coordinated negation across, creating another false positive.

The unchanged assertions retained a failed overall verdict; there were no
retries or favorable resampling. The transcript and actual local Sentence
Transformers report share the prefix
`reports/model-runs/2026-09-10T04-57-31-996Z-c758fe37-7ddf-4657-851a-9d2ef91d08da`.
The report's source hash was verified. Cosine scores were 0.7429, 0.8573,
0.8596, 0.8168, and 0.9054; calibration still overlaps, so scores remain
advisory and cannot rescue failed factual checks.

The shortfall checker now recognizes a direct "is/are not a multiple"
explanation, still requiring a colon label and the actual requested quantity.
The new unit regression covers plain and emphasized wording, a different
request quantity, the retained genuine shortage error, and shortage claims in
the same clause or later in the reply. An additional "exceeds" guard keeps a
case-pack explanation from excusing a simultaneous stock-deficit claim. This
remains targeted phrase coverage, not general language understanding.

The saved-response replay on 2026-09-10T13:30:33Z clears sample 4's false
shortfall flag while sample 1's genuine shortage remains rejected. Sample 5
still hits the unchanged fulfillment checker. The separate ignored
`.shortfall-replay.json` report records source/checker hashes and diagnostics
for the shortfall, nearest-quantity, and partial-fulfillment checks only. It
does not rerun every model assertion or generate any responses; original
transcripts, verdicts, and semantic scores remain unchanged. `npm run check`
passes 126 deterministic tests. The historical model run is still failed.

**Next task:** add a regression and fix the coordinated-negation false positive
in saved sample 5 ("no partial units or broken cases are permitted"), retaining
positive and contradictory fulfillment promises as negative controls. Recheck
saved replies without generating new ones. The genuine model shortfall error
and product-name routing collision remain queued as separate bounded tasks.

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
