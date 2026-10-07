# SABLE Systems

A local wholesale portal with inventory-aware ordering, account checkout, order
history, and COV-E customer support. Built with React, Vinext, Tailwind CSS,
Cloudflare Workers, and D1/SQLite.

## Quick start

Requires Node.js 22.13+, npm, and an OpenRouter API key with credits.

```sh
npm ci
cp .env.example .env
```

Set `OPENROUTER_API_KEY` in `.env`, then run:

```sh
npm run dev
```

Open [localhost:8016](http://127.0.0.1:8016). Sign in with a demo account:

| Email                             | Access phrase    |
| --------------------------------- | ---------------- |
| `mara.venn@calderpike.example`     | `Sable-WHS-0427!` |
| `imani.kade@meridiancivic.example` | `Sable-WHS-1098!` |
| `rowan.sato@northline.example`    | `Sable-WHS-2714!` |
| `lena.orr@halcyonexchange.example` | `Sable-WHS-5830!` |

The database initializes automatically and preserves existing records in
`.wrangler/`. Run `npm ci` again after pulling lockfile changes.

This demo uses fictional data and published credentials. Keep it on loopback;
public hosting requires private accounts and a separate access policy.

## Configuration

Launchers load `.env`; shell values take precedence. Keep the API key server-side.

- Chat: `deepseek/deepseek-v4.1-flash` through DeepInfra FP8 on OpenRouter.
- Judge: `z-ai/glm-5.3-flash` through OpenRouter, with reasoning enabled.

See [supported settings](.env.example),
[model defaults](lib/openrouter-config.json), and
[OpenRouter configuration](docs/inference.md#configuration).

## Tests and evaluations

Install [uv](https://docs.astral.sh/uv/getting-started/installation/) for Python
checks, then prepare the judge and browser tools:

```sh
npm run setup:judge
npx playwright install chromium
```

| Command                | Runs |
| ---------------------- | ---- |
| `npm run check`        | Lint, formatting, types, app and Python tests, seed validation, build |
| `npm test`             | App unit and integration tests |
| `npm run test:python`  | Offline judge tests |
| `npm run test:e2e`     | Build and browser tests |
| `npm run test:model`   | Live chatbot tests and advisory judging; billed |
| `npm run test:judge`   | Judge cases independently of chatbot generation; billed |
| `npm run audit:deps`   | Dependency security audit |

Offline and browser tests use mocked model responses. Live runs require the
OpenRouter key. Browser and live suites run separately from `npm run check`.

### Judge evaluations

The collection has **132 cases and 148 checks** for answers, claim extraction,
and claim verification. A pass means the judge matched the expected result,
including rejection of a bad answer. These are regression checks; the judge is
advisory.

```sh
npm run test:judge -- --list
npm run test:judge -- --concurrency 2
```

Reports in `reports/judge-runs/` show passed, failed, error, and pending counts.
Open the HTML report in a browser; JUnit XML and JSON evidence are also saved.
All reports are Git-ignored. See [filters, transcripts, and reporting](docs/inference.md#judge-evaluations).

## Guides

- [COV-E behavior, security, and local data](docs/genai-behavior-threat-model.md)
- [OpenRouter settings and runtime setup](docs/inference.md)
- Demos: [app walkthrough](docs/media/app-demo.mp4) (legacy local inference),
  [checkout test](docs/media/checkout-test.mp4), [preview images](docs/media/)
