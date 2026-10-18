# Authentication and permissions

Authentication is for the local demo: `SABLE_LOCAL_DEMO=true` and a loopback
request hostname are required. Published seed credentials are not suitable for
public deployment. See [Security boundaries](../README.md#security-boundaries).

## Sessions

Login requires an active user and distributor. Password verification uses
PBKDF2-SHA256; unknown and inactive accounts run the same derivation against a
dummy salt, so response time does not reveal active emails. The database stores
a hash of each random session token.
Cookies use `Path=/`, `HttpOnly`, `SameSite=Lax`, and `Max-Age=43200`, plus
`Secure` on HTTPS. Loopback HTTP intentionally omits `Secure`.

Sessions expire absolutely after twelve hours, including at the exact expiry
instant. Requests recheck expiry, revocation, user status, and distributor status.
Suspension blocks access; reactivation can restore an unexpired, unrevoked session.
A successful sign-in revokes the session the browser presented, in the same
write that creates the new one. Logout revokes only the presented session. If
revocation fails, the cookie remains available for a retry. Sign-in, sign-out,
and session checks time out after ten seconds in the browser.

## Permissions

`account_admin`, `buyer`, and `support` are stored role labels. They currently
have the same permissions; they do not grant administrative access or impose a
read-only restriction.

| Operation                                             | Required scope                                               |
| ----------------------------------------------------- | ------------------------------------------------------------ |
| Read catalog and inventory                            | Active authenticated identity                                |
| Read account, orders, shipments, returns, and charges | Authenticated distributor                                    |
| Place an order                                        | Authenticated distributor and reviewed user/account identity |
| List, continue, replay, or delete conversations       | Individual conversation owner                                |
| Create a conversation                                 | Active authenticated identity                                |

An account administrator cannot access a colleague's conversation, even within
the same distributor. Deleting a missing or foreign conversation is a successful
no-op. Checkout ownership and pricing come from the server. Support assistance
is read-only; that does not prevent a user with the `support` role from checking out.

## Mutation origins

All five mutation handlers (login, logout, checkout, incident deletion, and chat)
use [the request-origin policy](../lib/request-origin.ts) independently of session
authentication. A nonempty `Origin` must match the request URL's origin, including
scheme and port. Literal `null` and foreign origins are denied. When present,
`Sec-Fetch-Site` must be `same-origin`, `same-site`, or `none`; `cross-site` is
denied even with a matching origin. Missing or empty headers remain supported for
local server and CLI clients. These headers are not identity credentials.

## Request size limits

Mutation handlers stop reading a JSON body at a fixed size and return HTTP 413
before any database work.

| Handler           | Limit (UTF-8, including whitespace) |
| ----------------- | ----------------------------------- |
| Login             | 4 KiB                               |
| Checkout          | 16 KiB                              |
| Incident deletion | 1 KiB                               |
| Chat              | 32 KiB                              |

## Regression coverage

| Policy                                                                                      | Coverage                                                                        |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Origin and fetch-metadata combinations                                                      | [Request-origin unit tests](../tests/unit/request-origin.test.ts)               |
| Cookies, independent logout, exact expiry, revocation, suspension, and authenticated replay | [Session integration tests](../tests/integration/auth-session.test.ts)          |
| All role labels, checkout ownership, and same-distributor conversation isolation            | [Permission integration tests](../tests/integration/auth-permissions.test.ts)   |
| Missing/unknown sessions and untrusted origins denied before inference, writes, or replay   | [Support response safety](../tests/integration/support-response-safety.test.ts) |
| Distributor-scoped order history and totals                                                 | [Orders API tests](../tests/integration/orders-api.test.ts)                     |
| Incident ownership, deletion, and concurrent changes                                        | [Incident lifecycle tests](../tests/integration/incident-lifecycle.test.ts)     |
| Browser login/logout, retry, and session recovery                                           | [Authentication browser tests](../tests/e2e/auth-session.spec.ts)               |
