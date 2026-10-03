# Evaluation reports

Committed evaluation results, benchmark review records, and historical writeups
live here. Historical documents retain their original contents, including
preparation wording and settings that may no longer apply. For current commands
and interpretation, use [the evaluation guide](../docs/model-evaluation.md).

## Results

- [Full 45-answer recheck](full-support-recheck-results.md)
- [Expanded live support sampling](live-support-sampling-results.md)
- [Unavailable-record correction](record-access-correction-results.md)
- [Revision-13 benchmark](deepeval-benchmark-v3-results.md)
- [Revision-12 benchmark](deepeval-benchmark-v2-results.md)
- [Original structured benchmark](deepeval-benchmark-results.md)
- [Quality correction](deepeval-quality-results.md)

## Review records

- [Final benchmark review sheet](deepeval-benchmark-v4-review.md)
- [Revision-13 review sheet](deepeval-benchmark-v3-review.md)
- [Revision-12 review sheet](deepeval-benchmark-v2-review.md)
- [Original structured benchmark review sheet](deepeval-benchmark-review.md)

Review sheets retain their frozen bytes. Freeze manifests keep their original
`docs/` keys; the benchmark reader locates these relocated sheets under `reports/`
without changing approval hashes. Historical approvals do not approve current code.

## History

- [Evaluation development and verification history](model-evaluation.md)
- [Inference experiments and runtime verification](inference.md)

Raw transcripts and JSON/JSONL runs are generated into `model-runs/` and
`judge-runs/`. Those directories remain Git-ignored; selected reviewable reports
are committed here.
