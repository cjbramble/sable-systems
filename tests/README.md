# Test organization

- `unit/**/*.test.ts`: isolated tests that do not use D1, HTTP, a browser, or a language model.
- `integration/**/*.test.ts`: deterministic tests across application boundaries, including Miniflare and D1.
- `model/**/*.test.ts`: fixed-input evaluations that invoke the local support model through `npm run test:model`.
- `e2e/**/*.spec.ts`: reserved for future browser workflows. Use a browser runner such as Playwright rather than Vitest.
- `fixtures/`: shared test data and test-only identities; it contains no test cases.

Keep model evaluations separate from the default deterministic suite. Do not create an empty category directory before its first test is added.

Run deterministic checks with `npm test` and the full local model suite with
`npm run test:model`. The model runner also forwards Vitest filters, for example:

```sh
npm run test:model -- -t 'reports only authorized facts for an exact return'
```

Model assertions inspect the raw generated response; the API's identifier safety
check does not repair or mask model-evaluation failures.
