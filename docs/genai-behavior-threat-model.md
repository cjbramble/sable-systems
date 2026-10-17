# COV-E behavior and boundaries

COV-E provides read-only support for the signed-in distributor's orders,
shipments, returns, account, and inventory, plus the user's support incidents.

## Request flow

1. Authenticate the session.
2. Interpret the current question and relevant saved conversation.
3. Retrieve records scoped to the distributor or user.
4. Answer ambiguous references and single order, shipment, or return lookups with
   no match directly; otherwise send the policy, authorized records, and conversation
   to the support model.
5. Validate the response before returning or saving it.

The model cannot write SQL or change business records. Saving a chat exchange
only updates support history.

## Required behavior

| Area            | Expected behavior                                                                 |
| --------------- | --------------------------------------------------------------------------------- |
| Facts           | Use supplied records; distinguish stock availability from case-pack validity      |
| Missing records | Explain what is unavailable without inventing facts or implying foreign ownership |
| Authorization   | Do not disclose another distributor's records or another user's incidents         |
| Completeness    | Address each part of the current question, including separately available facts   |
| Conversation    | Follow explicit topic changes and resolve follow-ups from saved history           |
| Actions         | Refuse order changes, cancellations, and return approvals                         |
| Untrusted text  | Treat customer messages and stored record text as data, not policy instructions   |
| Links           | Do not share URLs, web addresses, or email addresses; link only to app pages      |
| Presentation    | Give concise answers; do not invent internal resources or render unsafe content   |

## Prompt injection defenses

Customer-written text reaches the model through the current message, saved
conversation history, incident titles, and order shipping destinations.

| Layer          | Behavior                                                                               |
| -------------- | -------------------------------------------------------------------------------------- |
| Message roles  | Policy is the only system message; records go in a labeled JSON data message           |
| Record scope   | Lookups return only the signed-in distributor's records and the user's incidents       |
| Server replies | Single-topic incident lists and missing-record answers are written without the model   |
| Reply checks   | Unverified record IDs are rejected; invented SABLE resources and links get one rewrite |
| Chat rendering | HTML and images are dropped; links outside the app have no target                      |

Link checks reject URLs with common schemes or a `//` host, protocol-relative and backslash hosts,
`www.` addresses, bare domains, IP addresses, and email addresses, including ones split by
invisible characters. Obfuscated text such as `example[.]com` is not detected,
but it is never clickable.

Tests: `tests/integration/support-prompt-injection.test.ts`,
`tests/unit/support-reply-links.test.ts`, and the Markdown tests in
`tests/e2e/support-history.spec.ts`.

## Coverage and limits

Offline application tests cover record scoping, API behavior, response validation,
and mocked failures. Browser tests cover user flows. Live chatbot tests check real
answers, including repeated samples and manipulation attempts paired with ordinary
requests. These checks cover specific examples, not every possible wording.

The separately configured GLM judge checks factual support, completeness, and
answer quality. Claim diagnostics check extraction and truth separately. Judge
results remain advisory and cannot override failed application checks. See
[the judge command and reports](../README.md#judge-evaluations).

The app is a local demo with synthetic data and published credentials. Public
hosting requires private accounts and a separate access policy. Arbitrary uploads,
multimodal attacks, and host compromise are outside the current evaluation scope.
