# OpenRouter inference

COV-E uses `deepseek/deepseek-v4.1-flash`; the advisory judge uses
`z-ai/glm-5.3-flash`. Both use OpenRouter. No local inference server is required.

## Configuration

Copy `.env.example` to `.env`, set `OPENROUTER_API_KEY`, and run `npm run dev`.
The launchers load `.env`; existing shell values take precedence. Keep the key
server-side, out of Git, and out of browser-visible variables.

| Variable                            | Default                        |
| ----------------------------------- | ------------------------------ |
| `OPENROUTER_SUPPORT_MODEL`          | `deepseek/deepseek-v4.1-flash` |
| `OPENROUTER_JUDGE_MODEL`            | `z-ai/glm-5.3-flash`           |
| `OPENROUTER_JUDGE_REASONING`        | `true`                         |
| `OPENROUTER_JUDGE_REASONING_EFFORT` | `high` (`low`, `high`, `max`)  |
| `OPENROUTER_JUDGE_MAX_TOKENS`       | `16384` (256–32768)            |

Defaults and provider policies live in [lib/openrouter-config.json](../lib/openrouter-config.json).
Chat pins the DeepInfra FP8 endpoint, disables reasoning, and limits replies to
600 tokens within an 8,192-token context budget. The request estimate includes
serialized messages, a chat-template reserve, and the reply allowance; see
[request budgeting](support-api.md) for overflow behavior. Chat overrides must be supported
by that endpoint. The judge uses reasoning and a structured response schema;
its token budget includes reasoning and the verdict. The judge explicitly asks
for `high` reasoning effort instead of GLM's `max` default. Effort is a model
control, not a hard token cap; unfinished verdicts still fail. Set effort only
when reasoning is enabled.

The implicit `high` setting applies to the default GLM judge. Other model
overrides keep their provider's default effort unless explicitly configured;
an explicit effort must be supported by the selected model.

For `openai/gpt-6-luna-pro`, the judge omits `temperature` and `top_p` because
its OpenRouter endpoints do not support those parameters. The model alias selects
pro reasoning mode; the same DeepEval metrics and provider privacy policy apply.
The adapter serializes DeepEval's schemas using OpenAI's strict object and
required-field rules, preserving nullable fields and SDK response validation.

Both configurations disable provider fallback, require supported parameters,
deny data collection, and request zero data retention. The judge lets OpenRouter
select a compatible endpoint. Unsupported settings fail rather than switching
to another model. Explicit environment overrides remain in effect.

## Judge metrics

DeepEval 4.2.2 owns LLM extraction, judgments, scores and evaluation execution.
Every metric receives the explicitly selected OpenRouter judge. The custom
`DeepEvalBaseLLM` adapter supplies schema-bound responses through the audited
transport; it does not grade answers. It preserves routing, retries, redacted
request evidence and the network restriction to OpenRouter.

| Check                        | DeepEval metric          | Acceptance                                                                       |
| ---------------------------- | ------------------------ | -------------------------------------------------------------------------------- |
| Whole-answer factual support | `GEval` with fixed steps | Every assertion is supported for the requested subject                           |
| Task completeness            | Independent `GEval`      | Every current requested item is addressed                                        |
| Support policy               | Independent `GEval`      | No unauthorized actions, disclosures, invented resources or evaluator directives |
| Conversation handling        | `ConversationalGEval`    | Diagnostic for the final reply's follow-up and topic handling                    |
| Standalone claim diagnostics | `FaithfulnessMetric`     | Strict mode; ambiguous claims are rejected                                       |

The three answer dimensions must all pass; their scores are never averaged.
Wrong information can supply a requested field while failing factual support.
Supported refusals can be complete. Ordinary wrong values do not automatically
fail the independent support-policy metric.

Whole-answer grounding receives the question and reference-only history, so it
can resolve pronouns and product identity. It checks the entire answer directly;
its result does not depend on a claim extractor finding every assertion.
Faithfulness uses the documented template extension for standalone claim
extraction and SABLE's evidence rules. Those diagnostic cases compare extraction
against an independently curated inventory of source quotes. Empty or incomplete
claim/verdict inventories are errors. Exact coverage checks remain Python.

The pinned SDK uses raw binary scores for strict single-turn GEval and raw
0–10 scores for ConversationalGEval. The adapter constrains those response schemas
before SDK conversion; malformed scores become execution errors. DeepEval still
owns judgments, score normalization and thresholds.

Captured authorized records supply `retrieval_context`; the customer request is
`input`. Policy and untrusted history remain distinct. History resolves follow-ups
but cannot establish current stock or status. Conversation diagnostics attach
current evidence only to the final assistant turn. They do not grade earlier
turns without their original evidence. Archived transcripts without separately
captured records use the fixture reference and label that fallback in the report.
These sampling transcripts measure raw generation, not the final served endpoint.

Collection reports use schema version 2; transcript reports use version 5.
The old structured assessment is replaced by native metric scores, thresholds,
reasons and success flags. Request evidence retains provider token usage and cost
when supplied. Conversation results are separate advisory diagnostics. Execution
errors remain errors, and transcript application factual checks remain required.

Evaluation caching, telemetry, cloud tracing and cloud uploads are disabled.
Ordinary tests use controlled model responses and make no billed inference calls.
Live evaluations require `npm run test:judge`. Rubric/model changes need calibration
against both existing controls and independently authored cases; passing controls
is not proof that a probabilistic judge will catch every defect.

The implementation follows DeepEval's [evaluation runner](https://deepeval.com/docs/evaluation-introduction),
[faithfulness](https://deepeval.com/docs/metrics-faithfulness),
[single-turn and conversation GEval](https://deepeval.com/docs/metrics-llm-evals), and
[custom model](https://deepeval.com/guides/guides-using-custom-llms) interfaces.

## Application behavior

Chat requests send customer questions, authorized records, and saved history to
OpenRouter and the selected provider. The seed data is fictional. Review service
terms and account privacy settings before using real customer data.

Authentication, account-scoped lookups, quotas, and response guards remain in
the application. Chat makes at most one corrective model retry. Missing credentials
or provider failures return safe errors without saving a completed exchange.
Chat and readiness requests reject redirects. Chat's two-minute deadline covers
response headers and bodies, including provider error responses. Timeouts return
504; cancelled model requests return 503. Neither triggers a corrective retry.
Judge transport retries are separate; see [judge evaluations](../README.md#judge-evaluations).

`/api/status` checks the non-generating key endpoint for credentials and reachability.
It does not establish credits, inference capacity, or response quality.

## Cloud runtime

Install Node dependencies with `npm ci`; prepare Python with `npm run setup:judge`
when running evaluator checks. Provide the API key as a runtime secret and allow
HTTPS to `openrouter.ai`. Offline checks do not require an API key.

When the environment requires an HTTP proxy, the judge honors `HTTPS_PROXY` or
`https_proxy` through a verified TLS CONNECT tunnel. Live Worker tests use the
host proxy bridge for the OpenRouter key and completion endpoints. Offline tests
retain dummy credentials. Neither transport follows redirects or disables TLS
verification.

Worker and browser tests require local sockets. In environments that supply a
child-process subreaper, use it for test launchers; give `uv` a writable cache.

Builds disable the published demo accounts. `npm start` enables them for a
loopback-only local preview. Public deployment requires private accounts and a
separate access policy.

## References

- [Provider routing](https://openrouter.ai/docs/guides/routing/provider-selection)
- [Reasoning controls](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)
- [Provider privacy](https://openrouter.ai/docs/guides/privacy/provider-logging)
- [Judge evaluations and reports](../README.md#judge-evaluations)
