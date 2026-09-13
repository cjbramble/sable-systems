# Model evaluation

For setup and commands, see [Testing](../README.md#testing). Model identity and
download details are in the [judge model record](../models/judge/README.md).

## Validation status

The local judge remains advisory and is not approved as a pass/fail gate for
chatbot responses. It has accepted incorrect claims, rejected correct answers,
and produced faulty explanations for otherwise correct verdicts.

Deterministic factual assertions remain mandatory. All 30 labeled judge examples
have informed development and now serve as calibration and regression cases.
The eight selected by `--holdout` are no longer an untouched validation set.

## Evaluation method

The runner generates chatbot responses, unloads that model, then loads the local
Qwen3-14B judge with an 8,192-token context and one processing slot. Evaluation
code, model configuration, and the locked Python project live in
`tools/evaluation/`; tests, assertions, and reference fixtures remain in `tests/`.

- **Normal evaluation:** DeepEval GEval applies fixed steps to the customer
  question, answer, and authored reference. Verdicts are schema-constrained and
  binary, using non-thinking generation at temperature 0 with seed 42.
- **Claim-level diagnostic:** Extracts claims from two labeled answers and checks
  each separately against the verbatim reference. An answer is judged faithful
  only when every claim receives `yes`; missing verdicts are errors. This does
  not check answer completeness.
- **Direct-claim diagnostic:** Bypasses extraction using four authored
  stock-quantity and product-identity controls. Each requires its explicit
  expected `yes` or `no`; ambiguity does not satisfy a negative control.

Live judge verdicts do not override factual failures. Labeled validation runs
fail on disagreement with an authored label. Transport, parsing, and model
errors fail the run. Reports retain inputs, model calls, verdicts, and checksums;
authored labels and rationales are withheld from the judge.

## Coverage limits

The case-pack assertion uses `tests/assertions/stock-availability.ts` to reject
recognized single-product stock promises above the available quantity, including
the observed 320-unit promise against 312 available. It covers the tested active,
passive, and alternative-quantity wording, not arbitrary prose.

Matching an overall label does not establish correct claim verification.
Equivalent wording has produced opposite judge verdicts. Adding the product name
did not resolve the tested overclaims; the earlier missing-identity hypothesis
was not supported by that experiment.

## Validation history

Agreement below means matching authored labels, not general model accuracy.
The prompt, reasoning-mode, and claim-level experiments are separate from the
active GEval configuration. Detailed settings and outputs are retained in the
linked local reports.

| Date | Evaluation | Agreement | Finding |
| --- | --- | --- | --- |
| 2026-09-12 | Initial GEval rubric | 13/22 | Nine false rejections |
| 2026-09-12 | Revised rubric | 22/22 | Calibration result; examples informed revision |
| 2026-09-12 | Eight new examples, frozen against `54fe73b` | 7/8 | Demanded an unrequested SKU; also missed the stock error in another rejection's explanation |
| 2026-09-13 | [Evidence-focused prompt][prompt] | 24/30 | Six false acceptances |
| 2026-09-13 | [Reasoning mode][reasoning] | 29/30 | Accepted the 320-unit stock overclaim |
| 2026-09-13 | [Original faithfulness metric][faithfulness] | 2/2 | Correct overall labels, but accepted the false stock claim and rejected a valid claim |
| 2026-09-13 | [Original two direct claims][direct] | 2/2 | Correctly distinguished 312 from 320 in the authored wording |
| 2026-09-13 | [Sequential full-answer verification][sequential] | 1/2 | Accepted all claims in the incorrect answer |
| 2026-09-13 | [Four direct-claim controls][identity] | 2/4 | Adding the product name did not fix the overclaims |

## Stock-overclaim verification

Deterministic stock-overclaim coverage was added in `5204698`. On 2026-09-13,
the full model suite passed all 35 tests, including five case-pack and five
comparison samples. The advisory judge accepted all ten samples without
execution errors, but one explanation incorrectly claimed the reference omitted
the quantity-adjustment instruction.

Evidence: [model transcript][full-transcript] and [judge report][full-judge].
These results do not establish judge reliability.

All linked run artifacts are local and Git-ignored, under `reports/model-runs/`
and `reports/judge-runs/`. They are not included in a fresh clone.

[prompt]: ../reports/judge-runs/validation-2026-09-13T04-39-29-267Z-fda8550b-5254-447e-9292-4ca2c3024076.json
[reasoning]: ../reports/judge-runs/validation-2026-09-13T10-49-54-842Z-16336bcd-f72c-4698-bf4e-54049bf79177.json
[faithfulness]: ../reports/judge-runs/claims-pilot-2026-09-13T12-27-01-297Z-efe3559f-37b7-4a9e-b65c-526f7e1a7d36.json
[direct]: ../reports/judge-runs/direct-claim-pilot-2026-09-13T12-59-03-648Z-0a386626-7297-416b-99f0-7bb3195c9217.json
[sequential]: ../reports/judge-runs/claims-pilot-2026-09-13T13-04-22-320Z-969ddebb-8ddb-41c4-b9be-f1b27e44c86c.json
[identity]: ../reports/judge-runs/direct-claim-pilot-2026-09-13T13-23-59-813Z-9131181a-bf33-4686-8a7c-3ce1359ccd52.json
[full-transcript]: ../reports/model-runs/2026-09-13T13-53-11-987Z-6d289aef-91d1-4e51-8196-8829c3d8e87a.log
[full-judge]: ../reports/judge-runs/transcript-2026-09-13T13-57-18-132Z-68e8545d-f322-4bd7-a4b5-d066fd1044ed.json
