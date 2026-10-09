# Support API

`POST /api/chat` requires an authenticated session and same-origin access.
Send only the current customer message:

```json
{
  "incidentId": "INC-your-conversation-id",
  "messageId": "your-message-id",
  "message": "Trace order SBL-2022-000118."
}
```

Provide both IDs to save an exchange. Incident IDs start with `INC-`, followed by
6–100 letters, digits, or hyphens. Message IDs contain 6–120 letters, digits, or
hyphens. Omit both IDs for a reply without persistence. The server builds model
context from authorized saved history; clients cannot supply earlier turns.

The former `messages` array is no longer accepted (HTTP 400). Migrate callers to
`message`, using the current customer text and preserving both IDs for retries.

Saved replies contain `message`, `customerCreatedAt`, `assistantCreatedAt`, and
`incidentUpdatedAt`. Timestamps are ISO instants. Replies without persistence
contain only `message`. Errors contain `error`; a deleted incident additionally
returns `code: "incident_deleted"` with HTTP 410.

Retry an uncertain saved exchange with the same IDs and text. Exact retries return
the saved reply without another model call. Reusing a message ID for different
text returns HTTP 409. A deliberate new message needs a new ID, even if its text
matches an earlier message. Distinct concurrent messages currently save in
completion order and may have been generated from the same earlier history.

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
