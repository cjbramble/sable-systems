# OpenRouter inference

COV-E and the advisory judge use OpenRouter. No local inference server is required.

## Configuration

Set `OPENROUTER_API_KEY` in `.env`. Launchers load that file; shell values take
precedence. Keep credentials server-side and out of Git.

| Variable                           | Default                       |
| ---------------------------------- | ----------------------------- |
| `OPENROUTER_SUPPORT_MODEL`         | `deepseek/deepseek-v4.1-flash` |
| `OPENROUTER_JUDGE_MODEL`           | `z-ai/glm-5.3-flash`          |
| `OPENROUTER_JUDGE_REASONING`       | `true`                       |
| `OPENROUTER_JUDGE_REASONING_EFFORT` | `high` (`low`, `high`, `max`) |
| `OPENROUTER_JUDGE_MAX_TOKENS`      | `16384` (256–32768)           |

Defaults and provider policies are in
[lib/openrouter-config.json](../lib/openrouter-config.json).

- Chat pins DeepInfra FP8, disables reasoning, and uses an 8,192-token prompt
  budget with a 600-token reply limit. Model overrides must work on that endpoint.
- The judge uses reasoning and structured responses. Its token limit covers
  both reasoning and the verdict; unfinished responses are errors. Configure
  effort only with reasoning enabled. Other model overrides use their provider's
  default effort unless explicitly set.
- Both request zero data retention, deny data collection, require supported
  parameters, and disable provider fallback.

Requests send customer questions, authorized records, and saved history to
OpenRouter and the selected provider. Authentication, account scoping, quotas,
and response validation remain in the app. Chat allows one corrective retry.

`/api/status` checks key access and reachability, not credits or inference capacity.

## Judge evaluations

Prepare Python with `npm run setup:judge`; live judging requires the API key and
incurs OpenRouter charges. DeepEval telemetry and cloud reporting are disabled.

```sh
npm run test:judge
npm run test:judge -- --list
npm run test:judge -- --category account-authorization --concurrency 2
npm run test:judge -- --transcript reports/model-runs/<run>.log
```

The collection checks answer facts, completeness, quality, claim extraction,
and claim truth. Expected results are stored in
[the case collection](../tests/fixtures/judge/judge-cases.json).
A pass means agreement with those expectations. Cases have informed development;
they are regression coverage, not an untouched benchmark.

`--list` needs no API key and makes no requests. Repeat `--category` to combine
categories without duplicate cases. All checks on each selected case run.
Concurrency is 1–4 cases (default 1); checks within a case run sequentially.
Transcript mode judges saved answers without generating new ones and cannot be
combined with category selection or listing.

Collection reports are saved under `reports/judge-runs/`:

| Format   | Use |
| -------- | --- |
| HTML     | Browser report with totals and expandable evidence |
| JUnit XML | CI and test-report viewers |
| JSON     | Settings, expected/actual results, and request totals |
| JSONL    | Incremental evidence |

Reports show passed, failed, error, and pending counts. A case passes when all
its checks pass. Disagreements are failures; API or response problems are errors.
Each completed check is saved before the next starts, preserving partial runs.
Category totals overlap. Failed, errored, or incomplete collection runs exit
unsuccessfully.

Transcript reports use JSON/JSONL. Judge verdicts are advisory; application
failures and execution errors still fail the run. Reports are Git-ignored.

HTTP 429s and incomplete HTTP 200 bodies share up to three retries.
Other failures are recorded without retrying.

## Runtime setup

Allow HTTPS to `openrouter.ai` and local sockets for Worker and browser tests.
Offline checks use dummy credentials and make no model requests.

The judge supports `HTTPS_PROXY` or `https_proxy` through a verified TLS tunnel.
Live Worker tests use the host proxy bridge. Neither transport follows redirects
or disables TLS verification.

Provide the key as a runtime secret when hosted. Public deployment also requires
private accounts and a separate access policy; builds disable demo access.

## References

- [Provider routing](https://openrouter.ai/docs/guides/routing/provider-selection)
- [Reasoning controls](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)
- [Provider privacy](https://openrouter.ai/docs/guides/privacy/provider-logging)
