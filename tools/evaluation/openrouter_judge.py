"""OpenRouter DeepEval adapter, without fallback or cloud reporting."""

import asyncio
import http.client
import json
import os
import random
import socket
import sys
import time
from contextvars import ContextVar
from email.utils import parsedate_to_datetime
from pathlib import Path
from urllib.parse import urlsplit

_openrouter_request = ContextVar("openrouter_request", default=None)
_openrouter_transport = ContextVar(
    "openrouter_transport", default=("openrouter.ai", 443)
)

# Set these before importing DeepEval, regardless of the caller's environment.
os.environ.update(
    {
        "DEEPEVAL_TELEMETRY_OPT_OUT": "1",
        "DEEPEVAL_TELEMETRY_ENABLED": "0",
        "DEEPEVAL_DISABLE_DOTENV": "1",
        "DEEPEVAL_UPDATE_WARNING_OPT_IN": "0",
        "DEEPEVAL_FILE_SYSTEM": "READ_ONLY",
        "CONFIDENT_TRACE_FLUSH": "0",
    }
)


def restrict_network(event, args):
    # The adapter fixes the HTTPS destination and verifies its TLS certificate.
    # Background SDK calls remain blocked, including during threaded judging.
    destinations = _openrouter_request.get()
    if destinations is not None:
        if event == "socket.getaddrinfo" and args[:2] != _openrouter_transport.get():
            raise PermissionError("Judge evaluation permits only OpenRouter resolution")
        if event == "socket.connect":
            address = args[1]
            if not isinstance(address, tuple) or address not in destinations:
                raise PermissionError("Judge evaluation permits only OpenRouter HTTPS")
        return
    if event in ("socket.getaddrinfo", "socket.connect"):
        raise PermissionError(
            "Judge network access requires an explicit OpenRouter request"
        )


sys.addaudithook(restrict_network)


def connect_openrouter(address, timeout, source_address=None):
    if address != _openrouter_transport.get() or source_address is not None:
        raise PermissionError("Unexpected judge HTTPS destination")
    destinations = _openrouter_request.get()
    if destinations is None:
        raise PermissionError("OpenRouter connection outside an explicit judge request")
    last_error = None
    # Use these resolved addresses directly; no second DNS lookup or redirects.
    for family, kind, protocol, _, destination in socket.getaddrinfo(
        *address, type=socket.SOCK_STREAM
    ):
        destinations.add(destination)
        connection = socket.socket(family, kind, protocol)
        try:
            connection.settimeout(timeout)
            connection.connect(destination)
            return connection
        except OSError as error:
            last_error = error
            connection.close()
    raise last_error or OSError("OpenRouter has no reachable HTTPS address")


# Load the SDK only after installing the privacy settings and network guard.
from deepeval.models import DeepEvalBaseLLM  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
DEFAULTS = json.loads((ROOT / "lib/openrouter-config.json").read_text())
GENERATION = {"temperature": 0, "top_p": 1, "max_tokens": 16384, "stream": False}

RETRY_POLICY = {
    "httpStatuses": [429],
    "transportErrors": ["IncompleteRead"],
    "transportHttpStatuses": [200],
    "maxRetries": 3,
    "backoffSeconds": [4, 8, 16],
    "jitterSeconds": 1,
    "maxDelaySeconds": 60,
    "honorRetryAfter": True,
}


def retry_delay(retry_after, attempt):
    """Honor a valid server delay; decline waits beyond our bounded budget."""
    delay = None
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


def summarize_requests(rows):
    """Count HTTP attempts separately from logical requests and case errors."""
    calls = [call for row in rows for call in row.get("calls", [])]
    groups = []
    for row in rows:
        requests = {}
        for index, call in enumerate(row.get("calls", [])):
            requests.setdefault(call.get("logicalRequest", index + 1), []).append(call)
        groups.extend(requests.values())
    limited = [
        group
        for group in groups
        if any(call.get("httpStatus") == 429 for call in group)
    ]
    recovered = sum(group[-1].get("completed") is True for group in limited)
    incomplete = [
        group
        for group in groups
        if any(
            call.get("httpStatus") == 200 and call.get("errorType") == "IncompleteRead"
            for call in group
        )
    ]
    recovered_incomplete = sum(
        group[-1].get("completed") is True for group in incomplete
    )
    return {
        "requestAttempts": len(calls),
        "retryAttempts": sum(call.get("attempt", 1) > 1 for call in calls),
        "rateLimitedAttempts": sum(call.get("httpStatus") == 429 for call in calls),
        "recoveredRateLimitedRequests": recovered,
        "unresolvedRateLimitedRequests": len(limited) - recovered,
        "incompleteResponseAttempts": sum(
            call.get("httpStatus") == 200 and call.get("errorType") == "IncompleteRead"
            for call in calls
        ),
        "recoveredIncompleteResponseRequests": recovered_incomplete,
        "unresolvedIncompleteResponseRequests": len(incomplete) - recovered_incomplete,
    }


def judge_config():
    model = (
        os.environ.get("OPENROUTER_JUDGE_MODEL", "").strip() or DEFAULTS["judgeModel"]
    )
    reasoning = (
        os.environ.get("OPENROUTER_JUDGE_REASONING", "").strip().lower() or "true"
    )
    if reasoning not in ("true", "false"):
        raise ValueError("OPENROUTER_JUDGE_REASONING must be true or false")
    effort = os.environ.get("OPENROUTER_JUDGE_REASONING_EFFORT", "").strip().lower()
    default_glm = model == DEFAULTS["judgeModel"]
    efforts = (
        ("low", "high", "max")
        if default_glm
        else ("minimal", "low", "medium", "high", "xhigh", "max")
    )
    if effort and (effort not in efforts or reasoning == "false"):
        raise ValueError(
            "OPENROUTER_JUDGE_REASONING_EFFORT must be "
            + ", ".join(efforts)
            + " with reasoning enabled"
        )
    reasoning_settings = {"enabled": reasoning == "true"}
    if reasoning == "true" and (effort or default_glm):
        reasoning_settings["effort"] = effort or "high"
    try:
        max_tokens = int(
            os.environ.get("OPENROUTER_JUDGE_MAX_TOKENS", "").strip()
            or GENERATION["max_tokens"]
        )
    except ValueError:
        raise ValueError(
            "OPENROUTER_JUDGE_MAX_TOKENS must be an integer from 256 to 32768"
        ) from None
    if not 256 <= max_tokens <= 32768:
        raise ValueError(
            "OPENROUTER_JUDGE_MAX_TOKENS must be an integer from 256 to 32768"
        )
    generation = dict(GENERATION)
    generation.update(
        {
            "max_tokens": max_tokens,
            "reasoning": reasoning_settings,
            "provider": DEFAULTS["judgeProvider"],
        }
    )
    return "openrouter", model, generation


def judge_metadata():
    provider, model, generation = judge_config()
    return {"provider": provider, "alias": model}, generation


class OpenRouterJudge(DeepEvalBaseLLM):
    def __init__(self):
        self.requests = []
        self.provider, self.model_name, self.generation = judge_config()
        super().__init__()

    def load_model(self):
        return self.model_name

    def get_model_name(self):
        return self.model_name

    def generate(self, prompt, schema=None):
        if schema is None:
            raise ValueError("Judging requires a response schema")
        body = {
            "model": self.model_name,
            "messages": [{"role": "user", "content": prompt}],
            **self.generation,
            "response_format": {
                "type": "json_schema",
                "json_schema": {
                    "name": "judge_verdict",
                    "strict": True,
                    "schema": schema.model_json_schema(),
                },
            },
        }
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
        logical_request = len(self.requests) + 1
        for attempt in range(1, RETRY_POLICY["maxRetries"] + 2):
            connection = http.client.HTTPSConnection(*destination, timeout=180)
            if proxy_url:
                connection.set_tunnel("openrouter.ai", 443)
            connection._create_connection = connect_openrouter
            transport_scope = _openrouter_transport.set(destination)
            network_scope = _openrouter_request.set(set())
            record = {
                "request": body,
                "logicalRequest": logical_request,
                "attempt": attempt,
            }
            self.requests.append(record)
            try:
                connection.request(
                    "POST", "/api/v1/chat/completions", json.dumps(body), headers
                )
                response = connection.getresponse()
                record["httpStatus"] = response.status
                read_error = None
                try:
                    raw = response.read(2_000_001)
                except http.client.IncompleteRead as error:
                    raw = error.partial
                    read_error = error
                record["responseBytes"] = len(raw)
                # read(amt) may return short on premature Content-Length EOF.
                record["responseComplete"] = read_error is None and getattr(
                    response, "length", 0
                ) in (0, None)
                record["rawResponse"] = (
                    raw[:2_000_000]
                    .decode("utf-8", errors="replace")
                    .replace(key, "[REDACTED]")[:2_000_000]
                )
                if read_error is not None:
                    raise read_error
                if (
                    response.status == 200
                    and not record["responseComplete"]
                    and len(raw) <= 2_000_000
                ):
                    raise http.client.IncompleteRead(raw, response.length)
                if response.status != 200 or len(raw) > 2_000_000:
                    raise RuntimeError(f"Judge HTTP failure: {response.status}")
                data = json.loads(raw)
                record["response"] = json.loads(
                    json.dumps(data).replace(key, "[REDACTED]")
                )
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
            except Exception as error:
                record["errorType"] = type(error).__name__
                incomplete = (
                    isinstance(error, http.client.IncompleteRead)
                    and record.get("httpStatus") == 200
                    and record.get("responseComplete") is False
                    and record.get("responseBytes", 2_000_001) <= 2_000_000
                )
                limited = (
                    record.get("httpStatus") == 429
                    and record.get("responseComplete") is True
                    and record.get("responseBytes", 2_000_001) <= 2_000_000
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
                    None if incomplete else response.getheader("Retry-After"), attempt
                )
                if delay is None:
                    record["retrySkipped"] = "retry-after-exceeds-wait-budget"
                    raise
                record["retryDelaySeconds"] = delay
            finally:
                _openrouter_request.reset(network_scope)
                _openrouter_transport.reset(transport_scope)
                connection.close()
            time.sleep(delay)

    async def a_generate(self, prompt, schema=None):
        return await asyncio.to_thread(self.generate, prompt, schema)
