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
600 tokens within an 8,192-token prompt budget. Chat overrides must be supported
by that endpoint. The judge uses reasoning and a structured response schema;
its token budget includes reasoning and the verdict. The judge explicitly asks
for `high` reasoning effort instead of GLM's `max` default. Effort is a model
control, not a hard token cap; unfinished verdicts still fail. Set effort only
when reasoning is enabled.

The implicit `high` setting applies to the default GLM judge. Other model
overrides keep their provider's default effort unless explicitly configured;
an explicit effort must be supported by the selected model.

Both configurations disable provider fallback, require supported parameters,
deny data collection, and request zero data retention. The judge lets OpenRouter
select a compatible endpoint. Unsupported settings fail rather than switching
to another model. Explicit environment overrides remain in effect.

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
