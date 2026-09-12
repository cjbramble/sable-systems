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
holdout. The result is calibration evidence; fresh holdout validation is pending.
The judge is not approved as a pass/fail gate for chatbot responses.
`npm run test:judge` reports label disagreements as failures; live-response
judgments remain advisory. Both run reports are retained locally under
`reports/judge-runs/`.
