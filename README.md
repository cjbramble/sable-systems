# SABLE Systems Distribution Portal

A local demo of a wholesale ordering portal with inventory, charge-account
checkout, order history, and COV-E support chat. Built with React, Vinext,
Tailwind CSS, Cloudflare Workers, and D1/SQLite. Chat uses OpenRouter;
no local model server is needed.

[Watch the demo](docs/media/app-demo.mp4)

## Setup

Requires Node.js 22.13+ and an OpenRouter API key with credits.

```sh
npm ci
cp .env.example .env
```

Set `OPENROUTER_API_KEY` in `.env`, then start the app:

```sh
npm run dev
```

Open [http://127.0.0.1:8016](http://127.0.0.1:8016). The database seeds itself
on first startup. Press Ctrl-C to stop.

Sign in with a demo account:

| Distributor           | Email                              | Access phrase     |
| --------------------- | ---------------------------------- | ----------------- |
| Calder Pike           | `mara.venn@calderpike.example`     | `Sable-WHS-0427!` |
| Meridian Civic        | `imani.kade@meridiancivic.example` | `Sable-WHS-1098!` |
| Northline Prosthetics | `rowan.sato@northline.example`     | `Sable-WHS-2714!` |
| Halcyon Industrial    | `lena.orr@halcyonexchange.example` | `Sable-WHS-5830!` |

Use `/shop` to order, `/orders` to view order history, and `/support` to ask
about authorized records. COV-E is read-only: it cannot change orders or returns.
This demo uses synthetic data and public credentials; keep it local.

## Configuration

The launchers read `.env`; shell variables take precedence. Keep the API key
server-side and out of Git. Hosted chat sends authorized records and conversation
history to OpenRouter and the selected provider.

| Variable                      | Default                        | Purpose                                                 |
| ----------------------------- | ------------------------------ | ------------------------------------------------------- |
| `OPENROUTER_API_KEY`          | Required                       | OpenRouter secret                                       |
| `OPENROUTER_SUPPORT_MODEL`    | `deepseek/deepseek-v4.1-flash` | Chat model                                              |
| `OPENROUTER_JUDGE_MODEL`      | `z-ai/glm-5.3-flash`           | Evaluation model                                        |
| `OPENROUTER_JUDGE_REASONING`  | `true`                         | Enable judge reasoning                                  |
| `OPENROUTER_JUDGE_MAX_TOKENS` | `16384`                        | Judge token limit, including reasoning; range 256–32768 |
| `SITE_URL`                    | `http://127.0.0.1:8016`        | Site metadata URL                                       |

Chat model overrides must support the pinned DeepInfra FP8 endpoint. Provider
and privacy settings are in [lib/openrouter-config.json](lib/openrouter-config.json).
See [inference configuration](docs/inference.md) for details.

## Commands

| Command               | Runs                                                               |
| --------------------- | ------------------------------------------------------------------ |
| `npm run dev`         | Local development server on port 8016                              |
| `npm run build`       | Production build                                                   |
| `npm start`           | Serve the build locally; build first                               |
| `npm run check`       | Lint, formatting, types, offline tests, seed validation, and build |
| `npm test`            | Application unit and integration tests                             |
| `npm run test:python` | Offline Python evaluator tests                                     |
| `npm run test:e2e`    | Build and Playwright browser tests                                 |
| `npm run test:model`  | Live chatbot tests and advisory judging; billed                    |
| `npm run test:judge`  | Judge calibration; billed                                          |

Before running `check` or Python evaluations, install [uv](https://docs.astral.sh/uv/getting-started/installation/) and prepare the judge environment:

```sh
npm run setup:judge
```

Before browser tests, install Chromium:

```sh
npx playwright install chromium
```

Offline and browser tests use mocked model responses. Live tests require the
OpenRouter key and spend credits. DeepEval judging is advisory; factual checks
remain mandatory. See [the evaluation guide](docs/model-evaluation.md) for
individual suites, coverage, and results.

Local database files are in `.wrangler/`; model and judge reports are in
`reports/`. Browser reports are in `playwright-report/`, with traces and
screenshots in `test-results/`. These directories are Git-ignored.

## Further reading

- [Local development, data maintenance, and demo recordings](docs/development.md)
- [OpenRouter configuration and cloud runtime](docs/inference.md)
- [Evaluation methods and results](docs/model-evaluation.md)
- [Chatbot behavior and threat model](docs/genai-behavior-threat-model.md)
