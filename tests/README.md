# Test organization

- `unit/**/*.test.ts`: isolated tests that do not use D1, HTTP, a browser, or a language model.
- `integration/**/*.test.ts`: deterministic tests across application boundaries, including Miniflare and D1.
- `model/**/*.test.ts`: fixed-input evaluations that invoke the local support model through `npm run test:model`.
- `e2e/**/*.spec.ts`: reserved for future browser workflows. Use a browser runner such as Playwright rather than Vitest.
- `fixtures/`: shared test data, test-only identities, and setup/cleanup helpers; it contains no test cases.

Keep model evaluations separate from the default deterministic suite. Do not create an empty category directory before its first test is added.

Run deterministic checks with `npm test` and the full local model suite with
`npm run test:model`. The model runner also forwards Vitest filters, for example:

```sh
npm run test:model -- -t 'reports only authorized facts for an exact return'
```

Model assertions inspect the raw generated response; the API's identifier safety
check does not repair or mask model-evaluation failures.

API response tests use `fixtures/support-api.ts` for real test sessions, fresh
mock model responses, direct database snapshots, and scoped cleanup. Create a
fixture per test and call `cleanup()` in `finally`, including around setup.
Register temporary incidents before creating them; registration refuses existing
records. Reading a seeded incident does not register it for deletion. Keep request
bodies, expected results, and assertions in the test rather than in the fixture.
