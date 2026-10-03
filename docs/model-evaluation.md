# Model evaluation

## Setup

Install [uv](https://docs.astral.sh/uv/getting-started/installation/), then prepare
the locked Python environment:

```sh
npm run setup:judge
```

Live evaluations require `OPENROUTER_API_KEY` in `.env` or the shell and spend
OpenRouter credits. Offline tests use mocked responses. See [inference configuration](inference.md)
for models, provider routing, and environment settings.

## Commands

| Command                                                           | Runs                                                        |
| ----------------------------------------------------------------- | ----------------------------------------------------------- |
| `npm run check`                                                   | Standard offline application and Python checks, plus build  |
| `npm run test:model`                                              | Live chatbot tests, followed by judging of retained samples |
| `npm run test:judge`                                              | Original 30-case calibration                                |
| `npm run test:judge -- --suite coverage`                          | Support, injection, and completeness controls               |
| `npm run test:judge -- --suite quality`                           | Factual-error and answer-quality boundaries                 |
| `npm run test:judge -- --suite record-access --concurrency 2`     | Unavailable-record and compound-request controls            |
| `npm run test:judge -- --suite claims`                            | Direct claim verification                                   |
| `npm run test:judge -- --suite extraction`                        | Claim extraction coverage and truth checks                  |
| `npm run test:judge -- --transcript reports/model-runs/<run>.log` | Judge saved samples without regenerating answers            |

Select live test files through the model launcher:

```sh
npm run test:model -- tests/model/expanded-support-sampling.test.ts
npm run test:model -- tests/model/support-behavior-baseline.test.ts
```

Expanded sampling covers nine scenarios with five answers each: orders,
shipments, returns, authorization, missing records, compound requests, topic
switches, and order/return action refusals. Each batch uses identical production
requests and full history; failed generator samples are not replaced or retried.
The full suite also includes case-pack and comparison sampling.

Judge runs are sequential by default. Use `--concurrency 2` or `4` for bounded
parallel grading. Suite selection cannot be combined with transcript, holdout,
or pilot modes. `calibration` and `calibration-v2` reuse retired benchmark cases.
`--holdout` selects exposed regression cases, not an untouched benchmark.

## Reading results

The structured judge assesses three dimensions independently:

- **Factual support:** every substantive claim must be supported by the reference.
- **Completeness:** every current requested item must be addressed. A supported
  no-record response covers unavailable fields of that record; separately
  available information is still required.
- **Answer quality:** check evaluator manipulation, off-topic text, unauthorized
  actions, foreign-account disclosure, and invented internal resources.

An answer passes only when all three dimensions pass. Claim diagnostics check
truth and extraction coverage separately; they do not establish answer completeness.
Expected labels and rationales are withheld from the judge.

For live sampling, application assertions remain mandatory and judge verdicts
are advisory. Judge acceptance cannot rescue a failed application assertion.
For labeled calibration, a passing check matches both the expected decision and
all expected dimensions. Correct rejection of a defective control counts as a
passing check. Execution errors never count as passes.

Reports separate application failures, judge disagreements, generator errors,
and judge errors. Compare expected and processed coverage before interpreting
pass counts. Regex assertions and authored controls do not cover every possible
semantic defect; score agreement does not replace human review.

## Retries and qualification

HTTP 429s and incomplete HTTP 200 bodies share a maximum of three retries.
Attempts retain identical requests and redacted evidence, close connections
before backoff, and report recovery separately from terminal errors. Other HTTP
errors, timeouts, malformed JSON, schema failures, and unfinished verdicts are
terminal. Retries may incur additional inference charges.

The judge remains advisory. Historical qualification approvals apply only to
their frozen source, settings, labels, and reviewed explanations. Current code
rejects those old freezes before calls; reproducing them requires their original
snapshot. Never refreeze exposed cases to approve a changed judge. A new gate
requires independently reviewed, untouched cases and review of actual judgments.

`qualification-v4` is an exposed benchmark for the frozen revision-14 evaluator. Its [reviewed plan](../reports/deepeval-benchmark-v4-review.md) and [results](../reports/deepeval-benchmark-v4-results.md) are retained in reports. Use fresh, independently reviewed cases to qualify a changed judge; preserve the existing freeze and results.

## Reports

- Live transcripts: `reports/model-runs/`
- Judge JSON and incremental JSONL: `reports/judge-runs/`
- Committed results, review records, and historical writeups: [reports/](../reports/README.md)

Raw run directories are Git-ignored. Committed reports preserve original failures
and evidence. Keep dated results in `reports/`; keep this guide focused on current usage.
