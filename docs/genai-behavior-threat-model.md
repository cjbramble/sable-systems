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
| Links           | Do not share URLs, web, email, or phone contacts; link only to app pages          |
| Presentation    | Give concise answers; do not invent internal resources or render unsafe content   |

## Prompt injection defenses

Customer-written text reaches the model through the current message, saved
conversation history, incident titles, and order shipping destinations.

| Layer          | Behavior                                                                                                                   |
| -------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Message roles  | Policy is the only system message; records go in a labeled JSON data message                                               |
| Record scope   | Lookups return only the signed-in distributor's records and the user's incidents                                           |
| Server replies | Single-topic incident lists and missing-record answers are written without the model                                       |
| Reply checks   | Unverified record IDs and reference codes are rejected; invented SABLE resources, links, and phone numbers get one rewrite |
| Chat rendering | HTML and images are dropped; links outside the app have no target                                                          |

Link checks reject URLs with common schemes or a `//` host, protocol-relative and
backslash hosts, `www.` addresses, bare domains, IP addresses, email addresses, and
phone numbers (a `+` or area-code prefix, digit groups split by spaces, dots, or
dashes, or a digit run after a word such as "call"), including ones split by
invisible characters. Obfuscated text such as `example[.]com` is not detected, but
it is never clickable.

Identifier checks normalize dash look-alikes and require any code after a
reference word (confirmation, refund, credit, RMA, ticket, case, claim, receipt,
invoice, reference) to be a verified record identifier. Product numbers and
identifiers the customer only asked about don't count. All-caps codes without
digits count after "number", "code", "ID", or "#"; dates such as 10/09/2026 are
not codes. Order destinations
must be one line, and support records show them as quoted strings, so stored
text cannot add record lines. Department, team, desk, hotline, and division
referrals are flagged without SABLE in front when a word such as "contact", "ask",
"call", "email", or "refer … to" introduces them, or when they are "at SABLE".
Units introduced by "a", "your", or "local" read as outside or customer-side and
pass. Saved incident lists reach the model as "[incident list shown]", so their
customer-written titles never read as the assistant's own words.

Tests: `tests/integration/support-prompt-injection.test.ts`,
`tests/unit/support-reply-links.test.ts`, and the Markdown tests in
`tests/e2e/support-history.spec.ts`.

## Coverage and limits

Offline application tests cover record scoping, API behavior, response validation,
and mocked failures. Browser tests cover user flows. Live chatbot tests check real
answers, including repeated samples and manipulation attempts paired with ordinary
requests. These checks cover specific examples, not every possible wording.

The DeepEval judge, which uses Luna, checks factual support, completeness, and
answer quality. Claim diagnostics check extraction and truth separately. Judge
results remain advisory and cannot override failed application checks. See
[the judge command and reports](../README.md#judge-evaluations).

The app is a local demo with synthetic data and published credentials. Public
hosting requires private accounts and a separate access policy. Arbitrary uploads,
multimodal attacks, and host compromise are outside the current evaluation scope.
