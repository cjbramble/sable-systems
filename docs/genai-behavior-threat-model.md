# COV-E behavior and boundaries

COV-E provides read-only support for the signed-in distributor's orders,
shipments, returns, account, and inventory, plus the user's support incidents.

## Request flow

1. Authenticate the session.
2. Interpret the question and relevant saved conversation.
3. Retrieve records scoped to the distributor or user.
4. Send the policy, authorized records, and conversation to the model.
5. Validate the response before returning or saving it.

The model cannot write SQL or change business records. Saving a chat exchange
only updates support history.

## Required behavior

| Area            | Expected behavior |
| --------------- | ----------------- |
| Facts           | Use supplied records; distinguish stock availability from case-pack validity |
| Missing records | Explain what is unavailable without inventing facts or implying foreign ownership |
| Authorization   | Keep other distributors' records and other users' incidents private |
| Completeness    | Address each part of the question, including separately available facts |
| Conversation    | Follow topic changes and resolve follow-ups from saved history |
| Actions         | Refuse order changes, cancellations, and return approvals |
| Untrusted text  | Treat messages and stored record text as data, not policy |
| Presentation    | Give concise answers; avoid invented resources and unsafe content |

## Local demo and security

The app uses synthetic data and published credentials. `npm run dev` and
`npm start` enable demo access on loopback; builds disable it. Authentication
requires both the `SABLE_LOCAL_DEMO=true` binding and a loopback hostname.
Keep the local runtime off public proxies and tunnels. Public hosting requires
private accounts and a separate access policy.

Login allows 10 attempts per email and 60 across the app per minute. Model
generation allows 30 requests per user per minute across sessions. A corrective
retry belongs to the same request; saved reply replay and server-built record
replies do not consume model quota. D1 stores limits across restarts; unavailable
quota storage blocks requests. Exceeded limits return HTTP 429 and `Retry-After`.

Assistant Markdown disables images and raw HTML. Failed server logout keeps the
session cookie so the user can retry.

`npm run audit:deps` checks npm advisories. The scoped `image-size` override
patches Vinext's dependency; remove it when Vinext no longer requires the patch.

## Local data

[db/schema.ts](../db/schema.ts) and [db/seed.ts](../db/seed.ts) define the database.
Startup preserves records and resumes interrupted initialization. Schema versions
6–8 upgrade to 9 with the current seed version. Unsupported states stop startup
without changing records.

Seed changes must update `SEED_VERSION`. A version change does not reset existing
data; rebuilding the dataset requires an explicit reset.

## Coverage and limits

Offline tests cover record scoping, API behavior, response validation, and mocked
failures. Browser tests cover user flows. Live chatbot tests check real answers,
repeated samples, and manipulation attempts. These cover specific examples,
not every possible wording.

The separate judge checks facts, completeness, quality, extraction, and claim
truth. Its verdicts are advisory and cannot override failed application checks.
See [judge evaluations](inference.md#judge-evaluations).

Arbitrary uploads, multimodal attacks, and host compromise are outside the
current evaluation scope.
