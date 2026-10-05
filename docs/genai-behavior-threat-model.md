# COV-E behavior and boundaries

COV-E provides read-only support for the signed-in distributor's orders,
shipments, returns, account, and inventory, plus the user's support incidents.

## Request flow

1. Authenticate the session.
2. Interpret the current question and relevant saved conversation.
3. Retrieve records scoped to the distributor or user.
4. Send the policy, authorized records, and conversation to the support model.
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
| Presentation    | Give concise answers; do not invent internal resources or render unsafe content   |

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
