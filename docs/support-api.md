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

| Limit                                             | Maximum                 | Failure  |
| ------------------------------------------------- | ----------------------- | -------- |
| Trimmed customer text                             | 4,000 UTF-16 code units | HTTP 400 |
| Request JSON, including whitespace                | 32 KiB in UTF-8         | HTTP 413 |
| Provider response body, including error envelopes | 1 MiB                   | HTTP 502 |
| Newly accepted reply text                         | 8,000 UTF-16 code units | HTTP 502 |

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
