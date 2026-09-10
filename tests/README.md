# Test organization

- `unit/**/*.test.ts`: isolated tests that do not use D1, HTTP, a browser, or a language model.
- `integration/**/*.test.ts`: deterministic tests across application boundaries, including Miniflare and D1.
- `model/**/*.test.ts`: fixed-input evaluations that invoke the local support model through `npm run test:model`.
- `e2e/**/*.spec.ts`: Playwright browser workflows, separate from Vitest and local-model evaluations.
- `e2e/pages/`: page objects that own browser selectors and user actions; business assertions stay in the specs.
- `e2e/fixtures/`: browser-specific setup, including the disposable application runtime and page-object instances.
- `fixtures/`: shared test data, test-only identities, and setup/cleanup helpers; it contains no test cases.

Keep model evaluations separate from the default deterministic suite. Do not create an empty category directory before its first test is added.

Run deterministic checks with `npm test` and the full local model suite with
`npm run test:model`. The model runner also forwards Vitest filters, for example:

```sh
npm run test:model -- -t 'reports only authorized facts for an exact return'
```

Model assertions inspect the raw generated response; the API's identifier safety
check does not repair or mask model-evaluation failures.

The read-only model scenario requests an order cancellation and a return
authorization using fixed seeds. It requires an explicit capability limitation,
rejects first-person and passive completion claims, and compares complete,
stably ordered business-table snapshots after each request (even on failure).
Like the other model cases, it exercises the real context builder and local
model, not the chat API's persistence path. Its phrase-based checks are targeted
regression coverage, not a general semantic evaluator of every possible reply.

API response tests use `fixtures/support-api.ts` for real test sessions, fresh
mock model responses, direct database snapshots, and scoped cleanup. Create a
fixture per test and call `cleanup()` in `finally`, including around setup.
Register temporary incidents before creating them; registration refuses existing
records. Reading a seeded incident does not register it for deletion. Keep request
bodies, expected results, and assertions in the test rather than in the fixture.

## Browser workflows

Install the pinned dependencies with `npm ci`, then install the browser once:

```sh
npx playwright install chromium
```

Run the browser suite with `npm run test:e2e`. This builds the production app
before running Playwright, so tests cannot silently use a stale build. Filters
are forwarded, for example:

```sh
npm run test:e2e -- --grep 'sends and reopens'
```

Each test gets a fresh Miniflare worker, disposable D1 database, and browser
context. The worker binds to loopback on an OS-assigned temporary port; it never
uses the development server, its `.wrangler` database, or reserved ports
8016/8017. The app seeds the test database through its normal initialization and
the test signs in through the real login form using a seeded local-only account.
The fixture disposes the worker and database even after failure.

Only outbound model/status requests are replaced with controlled replies;
unexpected worker outbound requests are blocked and fail the test. Browser
requests to login, support, and database-backed APIs are not mocked. These tests
check application behavior, not Qwen's response quality. `npm test` and
`npm run check` continue to run the deterministic unit/integration suite;
`npm run test:model` remains the separate real-model evaluation command.

Use `modelReply` for a fixed successful reply. For a failure/recovery workflow,
set `modelResponses` to an ordered list of `{ status, body }` values in a scoped
`test.describe` block. Array-valued [fixture options](https://playwright.dev/docs/test-fixtures)
need the long-form wrapper: `test.use({ modelResponses: [responses, { scope: 'test' }] })`.
The fixture copies that list for each test;
model-status polling does not consume it. Extra completion requests beyond the
configured sequence are blocked and fail the test, never sent to the real model.

`LoginPage` and `SupportPage` encapsulate selectors and interactions, following
the [Playwright page-object pattern](https://playwright.dev/docs/pom). Keep
scenario-specific inputs, expected responses, and database assertions in the
spec. `SupportMessage` is a message-scoped page component for inspecting formatted
replies; it keeps Markdown/HTML selectors out of scenarios and works after reload.
The rendering scenario uses harmless, local-only script probes and checks both
new and persisted replies. It is targeted regression coverage, not a complete
security audit. Prefer locator assertions and observed responses over fixed
sleeps. The suite uses Chromium with one worker and no retries; traces and screenshots are
retained on failure in ignored `test-results/`, with an HTML report in ignored
`playwright-report/` (`npx playwright show-report` opens it).
