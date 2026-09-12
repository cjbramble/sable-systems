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

The initial 2026-09-12 pilot matched 13 of 22 authored labels: nine false
rejections, no false acceptances, and no execution errors. This model/rubric
combination is not approved as a pass/fail gate for chatbot responses.
`npm run test:judge` reports label disagreements as failures; live-response
judgments remain advisory. Original labels and references are unchanged.
