# Local evaluation judge

Qwen3-14B, Q4_K_M, served locally with llama.cpp. Run `npm run setup:judge`
from the repository root to download and verify the model.

- Source: https://huggingface.co/Qwen/Qwen3-14B-GGUF
- Revision: `530227a7d994db8eca5ab5ced2fb692b614357fd`
- File: `Qwen3-14B-Q4_K_M.gguf` (9,001,752,960 bytes)
- SHA-256: `500a8806e85ee9c83f3ae08420295592451379b4f8cf2d0f41c15dffeb6b81f0`
- License: Apache-2.0, as specified by the source repository.

Weights and partial downloads are Git-ignored. Evaluation uses only the local
file and checks its checksum before starting the server.

## Validation status

The initial 2026-09-12 pilot matched 13 of 22 authored labels, with nine false
rejections. A rubric revision distinguishing factual correctness from reference
wording matched all 22 labels: 11 valid and 11 invalid answers. Neither run had
false acceptances or execution errors. The model, generation settings, examples,
references, and labels were unchanged between runs.

These examples informed the revision, including those originally labeled
holdout, so that result is calibration evidence.

Eight additional examples were authored against the frozen rubric at `54fe73b`.
Their first run on 2026-09-12 matched seven labels: one false rejection, no false
acceptances, and no execution errors. The judge demanded an unrequested item
number in a correct answer. It also gave a faulty explanation for a correctly
rejected answer, missing that a proposed 320-unit order exceeds 312 available
units. Labels, examples, rubric, and model settings were not adjusted after this
run. The judge remains unapproved as a pass/fail gate for chatbot responses.

On 2026-09-13, an evidence-focused GEval prompt template was tested once against
all 30 unchanged examples. The rubric, model, and generation settings were fixed.
It matched 24 labels, with six false acceptances, no false rejections, and no
execution errors. It missed a policy contradiction, an unavailable alternative,
swapped stock counts, an unrequested product, a missing requested identifier, and
incorrect price units. The candidate was not adopted; the prior implementation
was restored. The original false rejection and faulty explanation remain open.
The full candidate prompts and responses are retained in
`reports/judge-runs/validation-2026-09-13T04-39-29-267Z-fda8550b-5254-447e-9292-4ca2c3024076.json`.

On 2026-09-13, a reasoning-mode configuration matched 29 of the same 30 labels
in 1,951.78 seconds, with one false acceptance and no execution errors. All
responses included separate reasoning. It accepted the unsupported claim that
320 units could ship from 312 available. The prior configuration was restored;
reasoning mode was not adopted.

This run kept the rubric and labels fixed and used
[Qwen's recommended thinking-mode sampling](https://huggingface.co/Qwen/Qwen3-14B#best-practices):
temperature 0.6, top-p 0.95, top-k 20, and min-p 0, with seed 42. Thinking was
limited to 1,024 tokens within a 2,048-token response and a 300-second request
timeout. The model, 8,192-token context, and single processing slot were unchanged.
The report retains the settings, requests, reasoning, and verdicts:
`reports/judge-runs/validation-2026-09-13T10-49-54-842Z-16336bcd-f72c-4698-bf4e-54049bf79177.json`.

All 30 examples have now informed evaluation development; they are regression
and calibration cases, not an untouched holdout for future changes.

`npm run test:judge` includes all 30 examples; `--holdout` selects only the eight
additional cases in `tests/fixtures/judge/holdout.json`. That file records the
frozen rubric commit and authored label rationales, which are withheld from the
judge. Reports retain the fixture checksum and verdict explanations.
`npm run test:judge` reports label disagreements as failures; live-response
judgments remain advisory. Run reports are retained locally under
`reports/judge-runs/`.

## Claim-level pilot

`npm run test:judge -- --claims-pilot` uses DeepEval's claim-extraction and verdict
templates on the existing correct stock-alternative answer and the known
320-unit overclaim. It extracts answer claims once, then checks every claim
separately against the original reference verbatim, without extracting reference
facts. The non-thinking generation settings are unchanged. All claims must
receive `yes` verdicts to pass; ambiguous verdicts fail. Reports preserve the
reference, claims, individual verdicts, and model calls. Empty claims or missing
verdicts are execution errors. Normal evaluations still use GEval.

The original `FaithfulnessMetric` run on 2026-09-13 matched both overall labels in 86.02 seconds but
failed the diagnostic objective: it approved the claim that 320 units could ship
from current stock. It instead rejected the valid statement that the requested
quantity was not a whole-case multiple. Extraction omitted the explicit quantity
from that claim and the corresponding reference restriction. Overall label
agreement does not establish correct claim verification; this pilot is not
approved as a replacement or additional gate. No labels or references changed.

Evidence:
`reports/judge-runs/claims-pilot-2026-09-13T12-27-01-297Z-efe3559f-37b7-4a9e-b65c-526f7e1a7d36.json`.

### Direct verdict-stage probe

`npm run test:judge -- --direct-claim-pilot` sends one authored claim per call to
DeepEval's faithfulness verdict template, using the original reference verbatim.
It bypasses both extraction steps. The first pair differs only in quantity: 312
versus 320 units. An explicit `yes` and `no`, respectively, are required. The
second pair varies only whether the 320-unit overclaim explicitly names the
product; both require `no`. An ambiguous verdict does not satisfy a negative
control. All four cases run with the same reference and settings.

The first run on 2026-09-13 classified both claims correctly in 12.30 seconds.
The rejected claim's explanation correctly identified that 320 exceeds the 312
available. This is a focused diagnostic result, not validation of full-answer
judging. Model settings were unchanged. The probe cannot separately attribute
the improvement to reference preservation or one-claim-at-a-time verification.

Evidence:
`reports/judge-runs/direct-claim-pilot-2026-09-13T12-59-03-648Z-0a386626-7297-416b-99f0-7bb3195c9217.json`.

### Full-answer sequential verification

The reference-preserving pipeline was tested on both complete answers on
2026-09-13. It made five calls for the valid answer and seven for the overclaim
answer, completing in 47.62 seconds with no execution errors. The valid answer
passed, but all six claims from the invalid answer were also accepted, including
the 320-unit overclaim. It therefore matched only one of two labels.

The extracted stock claim remained intact but lacked the product name included
in the successful authored direct probe. That wording difference remains a
diagnostic hypothesis, not an established cause. The pipeline is still optional
and unapproved; the normal GEval evaluator and all original labels are unchanged.

Evidence:
`reports/judge-runs/claims-pilot-2026-09-13T13-04-22-320Z-969ddebb-8ddb-41c4-b9be-f1b27e44c86c.json`.

### Product-identity comparison

On 2026-09-13, the direct probe retained the original quantity pair and added two
320-unit claims differing only by the product name. It matched two of four labels
in 17.18 seconds, with no execution errors. Both new overclaims received `yes`,
while the original named 320-unit control again received `no` for exceeding stock.

Adding the product name did not correct this pair. The tested missing-identity
hypothesis is unsupported; semantically equivalent stock claims still produced
opposite verdicts under unchanged settings. The normal evaluator remains
unchanged and advisory. Further wording-specific tuning is not recommended;
deterministic validation of stock quantities is the proposed next step.

Evidence:
`reports/judge-runs/direct-claim-pilot-2026-09-13T13-23-59-813Z-9131181a-bf33-4686-8a7c-3ce1359ccd52.json`.
