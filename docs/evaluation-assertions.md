# Support answer evaluation assertions

The nine scenarios in `tests/fixtures/judge/live-support-scenarios.json` check raw
model answers against expected facts and account-scoped database context. These
checks do not measure the complete authenticated chat API. API tests separately
exercise response guards, corrective generation, persistence, and replay.

The status and availability checks require an affirmative fact about the requested
record or product. A required word or number elsewhere in an answer is insufficient.
Every recognized claim for that subject is checked, including conflicting repeats
and denials of the expected fact. An unavailable record cannot acquire a status.
An available quantity cannot be replaced by a reserved or requested quantity.

## Supported wording

- Direct status statements such as “is partially shipped”, “was closed”, and
  “status: delayed”; the order, shipment, and return statuses defined by the app
  are recognized with spaces, hyphens, or underscores.
- Status negation using “not”, “never”, “no longer”, “isn't”, or “wasn't”, with
  “currently” qualifiers. Denying an alternative status is allowed but does not
  replace the required affirmative status.
- Numeric availability labels such as “Available to promise: 312”, or quantities
  such as “312 units are available”. Negative, conflicting, or malformed quantities
  fail. Positive stock cannot also be described as unavailable or out of stock;
  negated denials such as “not out of stock” are allowed.
- Explicit record IDs and kind labels identify the subject. Subsequent pronouns
  and wrapped fields retain it; relational qualifiers such as “for this order”
  do not change the subject. A linked shipment's status cannot supply an order's
  missing status; a different product's quantity cannot supply the requested stock.
- Bold, italic, inline-code, and curly-apostrophe variants preserve these decisions.
  Simple ID/status table rows are supported; arbitrary tables are not interpreted.

These are bounded wording checks, not a general language validator. Quoted speech,
hypotheticals, implicit subject changes, and unrecognized paraphrases can fall outside
the grammar. Recognized claims about other records are not graded by the requested
record's fact checker. Carrier/reason labels, action refusals, and other scenario
requirements retain their existing checks.

Generic identifier/date/amount membership checks only establish that a token occurs
in authorized context. They do not establish entity or field association. Product
comparison checks separately validate their labeled fields. The resource check that
calls the production guard is consistency coverage, not an independent oracle.

Offline controls are independently authored positive/negative examples. Once used
to improve the checker, they are regression evidence, not an unseen benchmark.
Five-sample runs retain each original answer, failure, and request. All five must
pass; there is no majority vote or retry-until-pass. The separately configured judge
remains advisory and cannot replace the application verdict. Run `npm test` for
offline controls; live model and judge runs require explicit opt-in.
