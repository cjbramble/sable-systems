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

The case-pack repeated-sampling test asks that same question five independent
times using the application's normal generation settings (currently temperature 0.35,
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

A second repeated-sampling test compares Coldstart Rack Controller R2 with
Redline Power Cell R12 at those same normal generation settings. It shares its
question and factual checks with the fixed-input comparison regression. All five
replies must identify exactly the requested products, keep each product's price,
case pack, lead time, and availability correct, and omit Blackchannel. It uses
the same independent-request/failure-retention helper as the case-pack test.

```sh
npm run test:model -- -t 'preserves overlapping-name comparison facts across five samples'
```

Comparison requests, raw responses, answers, individual verdicts, and the final
batch summary are retained under separate `Comparison` log labels. Automatic
Sentence Transformers scoring now applies to both sampling scenarios, each with
its own references and report; comparison replies are never scored against
unrelated case-pack references.

`parseComparisonSamplingTranscript` now validates retained comparison evidence
separately: one request with the exact scenario question and normal generation
settings, five uniquely ordered verdicts, and one matching batch summary. Missing,
duplicated, malformed, or mismatched records fail instead of silently skipping.
Inference, response-format, and factuality failures retain their original verdicts
and details; failed runs are not promoted to passes. The parser preserves raw
response fields and answers, but does not re-run the factual checker or authenticate
the raw responses. Mixed transcripts remain isolated from the case-pack parser.

The comparison question is shared through `tests/fixtures/semantic/comparison.json`
to prevent producer/parser drift. The fixture also contains two authored reference
answers, six calibration examples, and six separate holdout examples. Each split
has three correct and three incorrect answers. Negatives cover a wrong price,
swapped availability, an off-topic answer, a wrong case pack, a wrong lead time,
and the unrequested Blackchannel product. Numeric values were checked against the
2026-09-02 seed inventory, not fitted to generated answers or similarity scores.

`unit/semantic/comparison.test.ts` checks unique IDs and normalized text, split
membership and labels, product/name associations, every labeled numeric fact in
the references and correct examples, and each negative's intended defect. Its
small parser handles only these authored, labeled product lines; it is not a
general factuality judge. In-memory corruption controls prove that duplicate text,
bad labels, incorrect prices/units/names, and accidentally repaired negatives fail.

Holdout texts are distinct, but this remains a small authored set with overlapping
vocabulary and answer formats, not an independent real-world benchmark. Comparison
scoring is now available through `test:semantic -- --scenario comparison`.
Calibration overlaps, so no comparison threshold is approved. Automatic scoring
after `test:model` evaluates whichever sampling scenarios ran, including both
when a transcript contains both.

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

The model-test runner scores the five replies from each sampling scenario with the
actual
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

`npm run test:model` automatically adds sibling reports for executed scenarios:
`<run>.semantic.json` for case-pack (preserving its existing filename) and
`<run>.comparison.semantic.json` for comparison. Absent scenarios are skipped
before loading Python. Filtered tests without either sampling scenario do not
require Sentence Transformers. `npm test` remains model-free. Every semantic
report records model/file hashes, package versions, evaluator and reference-set
hashes, the source transcript hash, per-reference cosine scores, pairwise reply
similarities, calibration results, and the original factual verdicts. Responses
over the encoder token limit are scored in complete token chunks, pooled by
token count and normalized; the report includes chunk counts. No answer suffix
is silently discarded.

The runner attempts each scenario once, even if the other has a factual failure,
malformed evidence, or a scoring/report-write error. Successful reports are kept;
errors are reported with their scenario names. A semantic failure makes a passing
model run fail, and no semantic success can clear an existing Vitest failure.
Original nonzero test exit codes are preserved. Reports remain exclusive writes:
an existing report is not replaced, and a failed scenario is not retried.

`unit/support-semantic-runs.test.ts` checks case-pack-only, comparison-only, mixed,
and absent-scenario outcomes, plus factual failures, scoring exceptions in either
order, and original test failures. It mocks the single-scenario scorer; existing
parser/scorer tests cover the underlying evidence selection and validation.

Run calibration alone, or score retained answers without generating new ones:

```sh
npm run test:semantic
npm run test:semantic -- --transcript reports/model-runs/<run>.log
```

The default scenario is still `case-pack`. Select comparison explicitly for its
own references, calibration examples, and saved answers:

```sh
npm run test:semantic -- --scenario comparison
npm run test:semantic -- --scenario comparison --transcript reports/model-runs/<run>.log
```

When replaying mixed transcripts with `test:semantic`, only the selected scenario
is scored. Both the JavaScript host and Python evaluator allow only `case-pack`
and `comparison`. Report
validation checks the selected scenario, exact answer association, its calibration
examples, and the reference-file hash before saving a result. A missing selected
scenario is reported as an error by the replay command, not treated as a successful
evaluation. `npm test` uses a mocked subprocess for the routing regression; it
still does not load either model.

Each completed scoring run writes a new report; existing evidence is never
overwritten. Replaying a transcript with any failed factual sample still exits
with failure, even when its similarity score is high. An inference failure with
no answer is explicitly listed as unscored, not given a synthetic passing score.

`unit/support-semantic.test.ts` checks partially and entirely unanswered batches
for both scenarios. Only available answers reach the mocked embedding subprocess;
their original sample IDs are preserved, including gaps. All five factual verdicts
and each unanswered sample's failure details remain in the saved report. An
entirely unanswered batch has empty score/pairwise arrays and still fails; it is
not confused with calibration-only evaluation or an absent scenario.

### What the scores mean

The case-pack fixture contains two authored reference answers, six labeled
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
- Sample 5 says "no partial units or broken cases are permitted." The
  fulfillment checker at the time matched "broken cases are permitted"
  without carrying the coordinated negation across, creating another false
  positive.

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
passed 126 deterministic tests at that milestone. The historical model run
is still failed.

Both case-pack model cases now use `assertions/partial-fulfillment.ts` to detect
affirmative partial-unit promises. It carries "no" across an uninterrupted
list of recognized unit phrases joined by "or", "and", or commas. The scoped
exception does not cross a completed predicate, contrast, or sentence boundary
to excuse a later promise. The unit regression covers plain/emphasized lists,
single-subject refusals (including line wraps), affirmative promises, and
contradictions before or after a refusal. This is targeted phrase coverage,
not a general language parser or a guarantee of complete promise detection.

The saved-response replay on 2026-09-10T13:56:25Z clears sample 5's false
fulfillment flag. Across the shortfall, nearest-quantity, and partial-fulfillment
checks, only sample 1 still fails for its genuine invented stock shortage.
The new ignored `.partial-fulfillment-replay.json` report records source/checker
hashes and each diagnostic; the source transcript and semantic report hashes
were verified unchanged. This is not a replay of every model assertion or a
new model run. No responses or semantic scores were regenerated. The historical
model run remains failed. `npm run check` passed 127 deterministic tests at
that milestone.

Physical-product context now supplies the explicit requested stock shortfall:
`max(0, requested - available)`. It uses the original requested quantity, not
the adjusted case-pack multiple, and explicitly separates shortfall from
adjustment distance. The new database-backed regression covers below/equal/above
stock, valid and invalid packs, a below-one-case request, and a second product
with zero availability despite inbound/quarantined units. For 318 requested and
312 available, the shortfall is 6—not the 2-unit adjustment distance or the
adjusted 320-unit order's 8-unit shortage. No physical shortfall is added for
digital licenses or a question with no recognized requested quantity.

One fresh targeted run on 2026-09-10T18:29:56Z passed **3 model tests, with 26
skipped**, including all five normal-generation samples. Both fixed-seed
quantity cases passed, and all five samples reported zero stock shortfall,
312 as nearest, and 304 as a valid alternative for the invalid 310-unit request.
All factual checks and generation settings were unchanged; there were no
retries or favorable resampling. This is bounded regression evidence, not a
full-model-suite result or a guarantee about every future reply.

The transcript and local Sentence Transformers report share the prefix
`reports/model-runs/2026-09-10T18-29-56-942Z-356c2673-f9a1-4e6a-af98-5ced3cac2fb5`.
The report's source hash was verified. Cosine scores were 0.5672, 0.5911,
0.5694, 0.5551, and 0.5677; calibration still overlaps, so scores remain
advisory. Earlier failed evidence is unchanged. `npm run check` passed
128 deterministic tests at that milestone.

The new no-quantity boundary check also exposed an existing classifier bug:
"How many SBL-RPC-12 units are available?" extracted 12 as the requested quantity
from the item-number suffix. The initial shortfall regression used product-name
wording to isolate calculation from this separate parser issue; the quantity
parser was not changed in that step.

The quantity parser now requires a quantity to start outside a word or
hyphenated item number. The new unit regression covers numeric SKU suffixes,
including leading zeros, mixed-case input, and an unknown item number, plus
product-name/storage-capacity controls. It preserves explicit quantities before
and after an item number, including a later real quantity following a misleading
SKU suffix, and keeps the normalized message intact for product matching.
The database-backed no-quantity check now includes the original exact-SKU
wording as well as the product name. Both regressions failed before the fix
and passed afterward. `npm run check` passed 129 deterministic tests at that
milestone.
No model generations or semantic scores were rerun for this deterministic
parser-only change; retained model evidence and factual checks are unchanged.

Full product-name and item-number matches now precede keyword-only matches,
with alphabetical order retained within each tier and no duplicate products.
The new database-backed regression checks Coldstart versus Blackchannel's
"controller" keyword and RelayMesh versus Palisade's "license" keyword.
It verifies both full-name and item-number questions, case normalization,
correct stock/price/allocation facts, the summary-intent path, and a keyword-only
lookup. The regression failed before the priority change and passed afterward.
All 25 catalog/order-grounding tests passed, and `npm run check` passed all
130 deterministic tests at that milestone. No model generations or semantic scores were rerun;
retained model evidence and factual checks are unchanged.

That step ranked candidates without excluding loosely matched candidates from
comparison results. The matcher now collects full-name/item-number matches
first and removes their literal text from a separate keyword-search copy.
Only the remaining text can identify additional products by alias. The original
message is unchanged, and explicit matches still lead the result without
duplicates. Aliases mentioned separately remain eligible; this is not a rule
that discards all aliases whenever an explicit reference appears.

The comparison regression has 15 independently authored prompt variants covering
Coldstart/Redline and RelayMesh/Redline, full names, item numbers, aliases,
repeated references, reversed order, and uppercase input. It also retains
Blackchannel when its alias is separately requested, including a separate
"controller" mention. Eight variants exposed unwanted third products before
the fix; all variants now pass. All 27 catalog/order/quantity-parser tests and
the full `npm run check` pass, with **131 deterministic tests** overall.
Model generations, semantic scores, and retained model evidence are unchanged.

The live-model overlapping-name comparison now requests Coldstart Rack
Controller R2 versus Redline Power Cell R12. Its independently authored
expectations require exactly those two item numbers in the authorized context
and response, and check each product's price, case pack, lead time, and available
units in its own labeled section. It also rejects Blackchannel/Haptic Controller
by name, even without an item number. The existing comparison assertions were
extracted unchanged into a shared helper used by both model cases.

One targeted run on 2026-09-10T20:43:07Z passed **2 model tests, with 28 skipped**
(30 model tests total): the existing Nightvault/Redline case and the new
Coldstart/Redline case. The new case uses seed 1613 and the existing fixed-seed
settings (temperature 0, top-p 1, maximum 300 tokens). There were no retries or
favorable resampling. This is bounded fixed-input evidence, not repeated
normal-generation coverage or a full-model-suite result.

The retained transcript is
`reports/model-runs/2026-09-10T20-43-07-897Z-a15e672b-d45d-4e30-bcb6-2f82d97f9edf.log`.
It includes the new question, seed, authorized context, answer, and verdict.
No Sentence Transformers report was produced: semantic scoring currently
applies to the separate case-pack sampling scenario, which was not selected.
Earlier transcripts and semantic evidence are unchanged. `npm run check`
continues to pass all **131 deterministic tests**.

The overlapping-name comparison now also runs five independent samples at the
actual application defaults (temperature 0.35, top-p 0.9, maximum 600 tokens,
no seed). Its question and factual checks are shared with the fixed-input case.
The existing case-pack loop was extracted into a shared helper without changing
its log protocol or checks. Both scenarios create fresh requests/timeouts,
assert identical request bodies, retain each raw response and verdict, classify
inference/response-format/factuality failures, and collect all five outcomes
before requiring an all-pass result. Retries remain disabled.

One fresh targeted run on 2026-09-10T20:55:06Z passed **3 model tests, with 28
skipped** (31 total): both five-sample scenarios and the fixed-input overlapping
comparison. All five comparison responses passed and had three distinct answer
texts; repeated wording is allowed, not required. There were no retries or
favorable resampling. This is bounded regression evidence, not a reliability
estimate for all possible responses. `npm run check` still passes **131
deterministic tests**, and the shared-loop change received a read-only review.

The transcript and case-pack-only semantic report share the prefix
`reports/model-runs/2026-09-10T20-55-06-349Z-ae21ae98-cf7f-45e9-86b0-e974a140719e`.
The comparison's five raw responses/answers/verdicts, generation settings, and
summary were verified against the transcript. The semantic report's source hash
and case-pack sample association were verified separately. Case-pack cosine
scores were 0.5677, 0.5242, 0.5815, 0.5677, and 0.5100; calibration remains
overlapping and scores advisory. Comparison samples were not embedded or scored
against case-pack references. All earlier evidence remains unchanged.

One new deterministic transcript regression now covers comparison-only and mixed
runs, skipped versus completed tests, missing/duplicate/malformed records, wrong
questions/settings, and failed samples whose details must match the summary. The
test failed before the parser existed and passed after implementation. The existing
case-pack regression still passes, and `npm run check` passes **132 deterministic
tests** plus lint, type checking, seed validation, and the production build.

A read-only replay of the retained 2026-09-10T20:55:06Z mixed transcript validated
all five comparison responses separately from all five case-pack responses. The
comparison raw content matched each retained answer; the existing semantic report
still matched only the case-pack samples and the full transcript's source hash.
Both evidence files were hash-checked unchanged. No new model generations or
semantic scores were produced for this parser-only step.

The comparison reference fixture now has two reference answers and twelve labeled
examples, split evenly between calibration and holdout. One deterministic
fixture-integrity test checks the authored facts and deliberate negative defects,
plus corruption controls. No model generation or semantic scoring was needed for
this step. Read-only checks confirmed the seed values and that the saved mixed
transcript still parses with its original question. The existing transcript and
case-pack semantic report hashes are unchanged. `npm run check` passes all **133
deterministic tests across 19 files**, plus lint, type checking, seed validation,
and the production build.

The evaluator and report validation now accept an explicit scenario, retaining
case-pack as the default. One focused routing regression checks isolated sample
selection from a mixed transcript, offline subprocess settings, reference hashes,
calibration identity, rejection of unknown scenarios, exclusive report writes,
and preservation of factual failures despite high similarity. It failed before
scenario routing was implemented and passes now. `npm run check` passes **134
deterministic tests across 20 files**, plus lint, type checking, seed validation,
and the production build.

Both scenarios were scored once with the real local Sentence Transformers runtime
using the existing 2026-09-10T20:55:06Z transcript, without generating new Qwen
answers. Comparison scores were 0.7904, 0.7904, 0.7904, 0.7854, and 0.8232.
Comparison calibration overlaps: minimum correct 0.9292 versus maximum incorrect
0.9998, with no candidate threshold. These scores do not supersede the original
factual verdicts. Case-pack scores matched the earlier report exactly.

New replay reports are retained at:

- `reports/model-runs/semantic-2026-09-10T21-22-19-912Z-2010d3cd-b0d2-4368-862c-d48c0acc258e.json` (comparison).
- `reports/model-runs/semantic-2026-09-10T21-22-28-903Z-bdc21156-121d-4be4-a1d9-6d351dc0f144.json` (case-pack).

Read-only audits verified both reports' scenario/sample associations, source,
fixture and evaluator hashes, and factual verdicts. The original transcript and
semantic report remain unchanged. Both command-line entry points reject unknown
scenario names before evaluation. No references or thresholds were tuned after
observing these scores.

The model-test runner now uses a shared scenario registry to attempt each executed
sampling scenario once, writing distinct reports and keeping other scenarios'
evidence even if one fails. One deterministic orchestration regression covers
case-pack-only, comparison-only, mixed, and absent scenarios, factual failures,
scoring/write exceptions, and preservation of original test exit codes. `npm run
check` passes **135 deterministic tests across 21 files**, plus lint, type
checking, seed validation, and the production build.

One fresh targeted model run on 2026-09-10T21:37:12Z passed **2 model tests, with
29 skipped** (31 total). All five case-pack and all five comparison replies passed
their existing factual checks. Both real Sentence Transformers reports were
created automatically by `test:model`, without a separate replay or retry.
This is bounded regression evidence, not a reliability estimate.

The transcript and reports share the prefix
`reports/model-runs/2026-09-10T21-37-12-980Z-fe444d42-4e77-4b8a-b586-ffab5da36eed`,
with suffixes `.log`, `.semantic.json`, and `.comparison.semantic.json`.
Case-pack scores were 0.5672, 0.5672, 0.5677, 0.5698, and 0.5381; comparison
scores were 0.7904, 0.8232, 0.7940, 0.7904, and 0.7904. Both calibrations still
overlap and scores remain advisory. Read-only audits verified raw answer
association, five ordered verdicts per scenario, generation settings, source,
fixture and evaluator hashes, and report isolation. The earlier mixed transcript
and original semantic report were hash-checked unchanged; all new evidence files
remain gitignored.

One new deterministic scorer regression now covers inference failures without
answers for both scenarios, using mixed and entirely unanswered batches. It
verifies exact subprocess inputs, non-renumbered answer IDs, explicit unscored
entries, original failure details and verdicts, failing batch outcomes despite
high scores on available answers, and persisted evidence. The test caught a
temporary mutation that judged only answered samples; the mutation was restored
before validation. No application/scorer behavior, references, or thresholds
changed, and no Qwen generations or real semantic reports were produced.
`npm run check` passes **136 deterministic tests across 21 files**, plus lint,
type checking, seed validation, and the production build.

**Next task:** add one focused scorer regression proving subprocess failures and
malformed evaluator output raise errors without writing a semantic report.

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
