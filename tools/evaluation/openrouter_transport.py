"""Bounded OpenRouter HTTPS requests, retries, and redacted response evidence."""

import http.client
import json
import os
import random
import time
from contextlib import closing
from email.utils import parsedate_to_datetime
from urllib.parse import urlsplit

from pydantic import BaseModel

from judge_runtime import connect_openrouter, request_scope
from judge_types import RequestRecord, RetryPolicy

MAX_RESPONSE_BYTES = 2_000_000

RETRY_POLICY: RetryPolicy = {
    "httpStatuses": [429],
    "transportErrors": ["IncompleteRead"],
    "transportHttpStatuses": [200],
    "maxRetries": 3,
    "backoffSeconds": [4, 8, 16],
    "jitterSeconds": 1,
    "maxDelaySeconds": 60,
    "honorRetryAfter": True,
}


def retry_delay(retry_after: str | None, attempt: int) -> float | None:
    """Honor a valid server delay; decline waits beyond our bounded budget."""
    delay: float | None = None
    if isinstance(retry_after, str):
        value = retry_after.strip()
        if value.isascii() and value.isdigit():
            # Avoid converting arbitrarily large untrusted integers.
            delay = (
                int(value) if len(value) <= 9 else RETRY_POLICY["maxDelaySeconds"] + 1
            )
        else:
            try:
                date = parsedate_to_datetime(value)
                if date.tzinfo is not None:
                    delay = max(0, date.timestamp() - time.time())
            except (TypeError, ValueError, OverflowError):
                pass
    if delay is None:
        delay = RETRY_POLICY["backoffSeconds"][attempt - 1] + random.uniform(
            0, RETRY_POLICY["jitterSeconds"]
        )
    return delay if delay <= RETRY_POLICY["maxDelaySeconds"] else None


def read_response(
    response: http.client.HTTPResponse, record: RequestRecord, key: str
) -> bytes:
    """Capture bounded, redacted evidence before validating the HTTP body."""
    read_error = None
    try:
        raw = response.read(MAX_RESPONSE_BYTES + 1)
    except http.client.IncompleteRead as error:
        raw = error.partial
        read_error = error
    record["responseBytes"] = len(raw)
    # read(amt) may return short on premature Content-Length EOF.
    record["responseComplete"] = read_error is None and getattr(
        response, "length", 0
    ) in (0, None)
    record["rawResponse"] = (
        raw[:MAX_RESPONSE_BYTES]
        .decode("utf-8", errors="replace")
        .replace(key, "[REDACTED]")[:MAX_RESPONSE_BYTES]
    )
    if read_error is not None:
        raise read_error
    if (
        response.status == 200
        and not record["responseComplete"]
        and len(raw) <= MAX_RESPONSE_BYTES
    ):
        raise http.client.IncompleteRead(raw, response.length)
    if response.status != 200 or len(raw) > MAX_RESPONSE_BYTES:
        raise RuntimeError(f"Judge HTTP failure: {response.status}")
    return raw


def parse_verdict[Response: BaseModel](
    raw: bytes,
    schema: type[Response],
    record: RequestRecord,
    key: str,
) -> Response:
    data = json.loads(raw)
    record["response"] = json.loads(json.dumps(data).replace(key, "[REDACTED]"))
    record.pop("rawResponse", None)
    if data.get("error"):
        raise RuntimeError("Judge returned an upstream error")
    choice = data["choices"][0]
    if choice.get("error"):
        raise RuntimeError("Judge returned an upstream error")
    if choice.get("finish_reason") != "stop":
        raise RuntimeError("Judge did not finish its verdict")
    verdict = schema.model_validate_json(
        choice["message"]["content"].replace(key, "[REDACTED]")
    )
    record["completed"] = True
    return verdict


def request_verdict[Response: BaseModel](
    body: dict[str, object],
    schema: type[Response],
    requests: list[RequestRecord],
) -> Response:
    """Send a schema-bound request, retaining every attempt in caller-owned evidence."""
    headers = {"Content-Type": "application/json"}
    key = os.environ.get("OPENROUTER_API_KEY", "").strip()
    if not key:
        raise ValueError("OPENROUTER_API_KEY is required for the OpenRouter judge")
    headers.update(
        {
            "Authorization": f"Bearer {key}",
            "X-OpenRouter-Title": "SABLE advisory judge",
        }
    )
    proxy_url = os.environ.get("https_proxy") or os.environ.get("HTTPS_PROXY")
    destination = ("openrouter.ai", 443)
    if proxy_url:
        proxy = urlsplit(proxy_url)
        if (
            proxy.scheme != "http"
            or not proxy.hostname
            or proxy.username
            or proxy.password
            or proxy.path not in ("", "/")
            or proxy.query
            or proxy.fragment
        ):
            raise ValueError(
                "Judge HTTPS proxy must be an HTTP endpoint without credentials"
            )
        destination = (proxy.hostname, proxy.port or 80)
    logical_request = len(requests) + 1
    for attempt in range(1, RETRY_POLICY["maxRetries"] + 2):
        connection = http.client.HTTPSConnection(*destination, timeout=180)
        if proxy_url:
            connection.set_tunnel("openrouter.ai", 443)
        # HTTPConnection uses this private hook for the guarded socket factory.
        connection._create_connection = connect_openrouter  # type: ignore[attr-defined]
        # Exit the network scope before closing, including failures and interrupts.
        with closing(connection), request_scope(destination):
            record: RequestRecord = {
                "request": body,
                "logicalRequest": logical_request,
                "attempt": attempt,
            }
            requests.append(record)
            try:
                connection.request(
                    "POST", "/api/v1/chat/completions", json.dumps(body), headers
                )
                response = connection.getresponse()
                record["httpStatus"] = response.status
                raw = read_response(response, record, key)
                return parse_verdict(raw, schema, record, key)
            except Exception as error:
                record["errorType"] = type(error).__name__
                incomplete = (
                    isinstance(error, http.client.IncompleteRead)
                    and record.get("httpStatus") == 200
                    and record.get("responseComplete") is False
                    and record.get("responseBytes", MAX_RESPONSE_BYTES + 1)
                    <= MAX_RESPONSE_BYTES
                )
                limited = (
                    record.get("httpStatus") == 429
                    and record.get("responseComplete") is True
                    and record.get("responseBytes", MAX_RESPONSE_BYTES + 1)
                    <= MAX_RESPONSE_BYTES
                )
                if not (incomplete or limited):
                    raise
                record["retryReason"] = (
                    "incomplete-response" if incomplete else "rate-limit"
                )
                if attempt > RETRY_POLICY["maxRetries"]:
                    record["retryExhausted"] = True
                    raise
                delay = retry_delay(
                    None if incomplete else response.getheader("Retry-After"),
                    attempt,
                )
                if delay is None:
                    record["retrySkipped"] = "retry-after-exceeds-wait-budget"
                    raise
                record["retryDelaySeconds"] = delay
        time.sleep(delay)

    raise RuntimeError("Judge exhausted request attempts")
