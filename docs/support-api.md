# Support API

`POST /api/chat` requires an authenticated session and same-origin access.
Send only the current customer message:

```json
{
  "incidentId": "INC-your-conversation-id",
  "messageId": "your-message-id",
  "message": "Trace order SBL-2022-000118.",
  "expectedRevision": 0
}
```

Provide both IDs and `expectedRevision` to save an exchange. Incident IDs start with `INC-`, followed by
6–100 letters, digits, or hyphens. Message IDs contain 6–120 letters, digits, or
hyphens. The revision is a nonnegative safe integer: use 0 for a new conversation,
or the revision loaded with that incident from `GET /api/incidents`. Omit IDs and
revision for a reply without persistence. The server builds model
context from authorized saved history; clients cannot supply earlier turns.

Explicit order IDs, customer POs, shipment IDs, and tracking references select
their respective fields. POs are normalized to uppercase. Unlabeled order references
are checked as IDs and POs; unlabeled shipment references as IDs and tracking
references. Multiple matching records within the account prompt clarification.
For a single unresolved reference, a reply such as “It’s the order ID” or “the
customer PO” selects the named field without repeating the reference.
Follow-ups such as “that order” retain their named entity; a shipment mentioned in an answer
does not replace the customer's order. A product named by its full name or alias
can be the target of “it”, and after a list question “it” means the one record or
item the answer named. Category words such as “power” or “security” request a
category only beside a catalog cue (“power products”, “in stock”), so they do not
replace a record follow-up. Multiple or missing conversational targets
also ask for clarification. Clarification replies are saved and replayed like other
successful replies, without a model call or model quota consumption.

Order, shipment, and return lookups retain structured outcomes, facts, and verified
references separately from model prompt text. A single unavailable record receives a fixed, saved reply
before model quota consumption; compound requests retain both found and unavailable
parts. References mentioned only in an order's destination, product snapshots, or
event descriptions do not become verified identities. The same applies to shipment
carrier names, return reasons, and returned product snapshots. An unavailable reference
may be echoed in its requested namespace without establishing that a record exists.
Individual product lookups and comparisons also retain typed facts and canonical
item numbers; product and fulfillment-location names do not verify identifiers.
Product facts distinguish catalog eligibility from stock and quantity constraints.
Any retirement marker excludes new orders, matching checkout policy. Retired products
remain available for historical questions, but remaining stock does not permit new
orders and support does not suggest order quantity adjustments for them.
Category listings and physical low-stock advisories also retain typed facts and
canonical item numbers. Unknown-item outcomes keep requested item numbers separate
from verified identities: replies can echo them as items, but cannot reuse them as
order, shipment, or return references. These outcomes still use model replies.
Order searches retain typed criteria, scoped total counts and up to six listed
orders. Only listed order IDs/POs and the matched product filter verify identifiers;
product and account display names do not. Count and preview queries run together.
Account and summary lookups retain typed account facts. Only the order IDs and
authorization codes from the eight most recent scoped charges verify record
identifiers; unlisted `ACC-` authorization codes are rejected. Account names,
payment terms, and other descriptive fields do not verify identifiers.
Incident-history facts retain up to eight entries for the authenticated user, with
canonical incident IDs and message counts. Titles do not verify identifiers. Single
incident-list requests still receive saved, server-built replies without a model
call. All callers use typed outcomes. Identifier validation accepts only those
outcomes; rendered prompt text cannot supply record identity evidence. Model
evaluations keep the typed evidence separate from the prompt text as well.
Catalog requests retain known and unknown item outcomes together in request order.
Explicit item numbers, full product names and comparisons cover up to three distinct
targets, counting unknown items toward that limit; remaining targets are listed as
omitted with a request to ask about them separately. Omitted items are not claimed to be missing.
Unknown and omitted item numbers can be echoed as items, but cannot authorize
order, shipment, or return references. Quantities stay attached to their own item,
including when another requested item is unknown; more than three quantified
targets prompt clarification.

Explicitly requested account details, order searches, incident history, and catalog
questions are retained in source order, with or without named records. For example,
“What are my payment terms? Are 16 units of SBL-RPC-12 available?” retrieves account
and catalog facts together. Named order, shipment, and return references can be
included in the same message. Product filters stay with their order search;
descriptions attached to a record do not trigger another account lookup or search.
Repeated account and incident-history requests are grouped. Catalog targets remain
grouped as one request, positioned at their first mention.

Only the first three parts are retrieved. Remaining parts are listed as omitted,
with a request to ask about them separately. Omitted references can be echoed in
their requested namespaces, but do not verify record identities or imply that
records are missing. A single incident-list request receives a server-built reply;
a mixed request uses the scoped facts for all selected parts. Incident titles are
customer-written labels and cannot verify record identities or SABLE resources.

Internal resource referrals are checked separately from record identifiers. Markdown
emphasis, inline code, and inline link labels do not hide SABLE/COV-E attribution.
“Our” and “my” resource claims also refer to internal resources. Direct denials such
as “the records do not provide a SABLE returns specialist” are allowed, as is advice
to consult an outside qualified professional. Inability to contact a resource or
refer someone to it does not establish that the resource is absent or unverified.
Denials apply locally to their resource;
they cannot excuse a later referral. The original accepted answer is returned and saved.

Only explicit verified resource facts can authorize an internal name; prose mentions
in records, events, customer requests, or incident titles cannot. The current database
has no structured internal-resource catalog, so it supplies no such allowances. An
unsupported referral gets one corrective generation attempt; a second failure returns
an unsaved error. Detection covers bounded attribution and direct-denial wording, not
arbitrary paraphrases, quotation semantics, implicit referrals, or every Markdown form.

Before inference, the server estimates the whole prompt from serialized UTF-8
message bytes, including policy, encoded records, current question, history, and
any corrective instruction. It reserves space for the reply and chat template.
Only older whole conversation messages may be removed; retained history starts
with a customer message. Authorized records and the current question are never
truncated. This is a conservative estimate, not exact tokenization; the provider
can still reject a request for exceeding its context limit.

If mandatory content exceeds the estimate, the API returns an unsaved 422 error
with a request to shorten the message or ask about one order or product and fewer
details. An initial overflow consumes no model quota and performs no fetch. A
corrective request uses the same budget; overflow stops it before a second fetch
or any save, with only the initial request's quota charge.

Each follow-up clause retains its resolved target even when another clause asks
for incident history or an order search. Missing or ambiguous targets still prompt
clarification before inference. Shared requests such as “Show my support incidents
and my orders” retain both topics. An incident qualifier such as “for this year”
does not suppress a separate item-availability question; coordinated product names
that describe incidents remain part of the incident request.

Quantity lookups accept whole numbers from 1 through 999,999, with optional comma
grouping such as `1,000`. Attach each quantity to its product, or use shared wording
such as “24 units each.” Fractional, invalid, or ambiguous quantities prompt a saved
clarification before the model is called. Quantity requests can assess up to three
matched products; an unclear target or a larger set also prompts clarification.

Order searches support status lists and explicit exclusions, such as “shipped or
partially shipped orders,” “orders that are not cancelled,” and “active orders
excluding on hold.” Active orders exclude scheduled, delivered, and cancelled
statuses. Ambiguous negation, unknown explicit statuses, and contradictory filters
prompt a saved clarification without a model call. Phrasings such as “don't
show”, “hide”, “skip”, or “other than” count as ambiguous negation. Excluding
scheduled orders does not change a year filter from the order's creation year to
its requested ship year.

A year filter covers one whole year. Amounts and quantities such as “over $2000”
or “2048 units” are not years. Dates, months, relative dates such as “this month”,
ranges, and several years prompt a clarification. A search naming several products matches orders containing any of
them. “Order” followed by a product item number, or after phrasing such as “can I”
or “want to”, is read as buying the product, not as an order reference.

The former `messages` array is no longer accepted (HTTP 400). Migrate callers to
`message` and `expectedRevision`, preserving the entire command for retries.

Saved replies contain `message`, `revision`, `customerCreatedAt`, `assistantCreatedAt`, and
`incidentUpdatedAt`. Timestamps are ISO instants. Replies without persistence
contain only `message`. Errors contain `error`; a deleted incident additionally
returns `code: "incident_deleted"` with HTTP 410.

Other rejections may include `code: "request_not_saved"`: that HTTP attempt ended
without writing an exchange. This does not settle an earlier attempt whose response
was lost. A network error, malformed response, or unclassified save failure leaves
the command's outcome unknown; keep its original IDs, text, and expected revision.

Retry an uncertain saved exchange with the same IDs, text, and expected revision. Exact retries return
the saved reply without another model call. Reusing a message ID for different
text returns HTTP 409. A deliberate new message needs a new ID, even if its text
matches an earlier message.

Each saved exchange advances the incident revision once. Distinct messages using
the same revision compete at save time: only one can succeed; the other receives
HTTP 409 with `code: "incident_changed"`. A revision already stale at receipt is
rejected before model generation or quota consumption. A conflict during generation
discards that generated reply without saving either message.

On `incident_changed`, reload the incident, preserve the rejected text, and let the
customer review the updated conversation before explicitly sending with a new
message ID and the refreshed revision. The support page provides this reload flow;
it never resends automatically. An ordinary unchanged retry cannot resolve this
conflict.

A replay returns the original reply's revision even if later exchanges exist.
Clients must not treat that receipt as proof they have loaded later history.
Existing records start at revision 0 after the schema upgrade. Recovering a missing
historical assistant reply advances the revision; replaying a complete pair does not.

The support page keeps editable drafts separately for each incident and labels
submitted messages as pending, not saved, or unconfirmed until resolved. A newer
draft can be edited while retrying the original command. Dependent sends remain
blocked until the exchange is confirmed, a known unsaved message is explicitly
discarded, or the customer completes conversation-change recovery.

“Check saved conversation” confirms an uncertain exchange only when saved history
contains its matching customer/assistant pair. An absent message or new incident
does not prove failure: its original request may still be running. A later revision
without the pair proves that the old command can no longer save and allows explicit
review and resubmission. Checking history never sends a message automatically.

Drafts stay in memory while switching incidents. Deleting an incident clears its
local draft; remote deletion preserves unsent text for recovery into a new incident.
Reloading the page or changing accounts clears local drafts and pending recovery.

The support page requires valid account details and saved history before showing
either. A loading failure appears as soon as it is known, cancels the other read,
and offers “Retry support”; an expired session redirects to login. Both responses,
including their bodies, share a ten-second deadline. Retrying starts a fresh pair
of reads, and canceled or older results cannot replace the current view. Failed or
malformed history is never presented as an empty conversation list.

Model failures are unsaved (`code: "request_not_saved"`) and can be retried:

| Model outcome                                                               | Response                    |
| --------------------------------------------------------------------------- | --------------------------- |
| Provider HTTP 401, 402, 403, 429, or 5xx; HTTP 200 with an `error` envelope | HTTP 503, model unavailable |
| Provider HTTP 429 with a valid `Retry-After`                                | HTTP 503 with the same wait |
| Provider context-length rejection (HTTP 400)                                | HTTP 422                    |
| Other provider rejections; empty, cut-off, ungrounded, or oversized replies | HTTP 502                    |
| No response before the deadline                                             | HTTP 504                    |

Provider failures and rejections log the provider status code to the Worker log,
never the provider body or API key.

| Limit                                                         | Maximum                 | Failure  |
| ------------------------------------------------------------- | ----------------------- | -------- |
| Trimmed customer text                                         | 4,000 UTF-16 code units | HTTP 400 |
| Request JSON, including whitespace                            | 32 KiB in UTF-8         | HTTP 413 |
| Provider response body, including error envelopes             | 1 MiB                   | HTTP 502 |
| Newly accepted reply text                                     | 8,000 UTF-16 code units | HTTP 502 |
| New support commands per user, including server-built replies | 60 per minute           | HTTP 429 |
| Model requests per user (a corrective retry is not counted)   | 30 per minute           | HTTP 429 |

Exact retries of saved commands are replays and count against neither quota.
UTF-16 counts most emoji as two units. Oversized output is rejected before storage,
without truncating the answer. The same command can be retried after rejection.
Saved history and replayed replies are not revalidated against new-generation
text limits. The existing provider deadline covers response-body reads as well
as the initial request.

`GET /api/status` returns `{ "ready": true }` with HTTP 200 when the provider's
credential and gateway check succeeds, or `{ "ready": false }` with HTTP 503.
It does not run a billed generation or guarantee credits, model capacity, or reply
quality. The support connection badge reflects only this check; chat replies and
failures do not change it.

The page checks immediately while visible, then waits ten seconds after each check
finishes. Only one check runs at a time, with a five-second deadline including its
response body. Invalid responses, network failures, and timeouts show offline.
Hidden tabs pause checks and cancel pending work; returning to the tab checks again.
The previous observation stays visible until a new check finishes.

The HTTP route owns request trust, bounded body parsing, authentication, and status
mapping. `answerSupportMessage` accepts the parsed command, authenticated identity,
database connection, and model transport. It owns replay, authoritative history,
retrieval, budgeting, quota, generation, validation, and persistence in that order.
Its results distinguish an answer, quota exhaustion, and a classified failure;
uncertain saving failures retain no `request_not_saved` code. Incident ownership
and lifecycle checks remain inside the service's database operations, including
replay, so other authenticated callers cannot bypass them.
