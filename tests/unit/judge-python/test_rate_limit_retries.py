"""Exercise the real adapter and reporting with an offline HTTP transport."""

import http.client
import io
import json
import random
import time
from datetime import UTC, datetime
from email.utils import format_datetime

import pytest
from pydantic import BaseModel

import judge_collection as collection
import judge_runtime
import openrouter_judge as adapter
import openrouter_transport as transport
import support_grading as grading
from judge_errors import JudgeError
from request_summary import summarize_requests


class Verdict(BaseModel):
    score: int
    reason: str


@pytest.fixture
def http_sequence(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "retry-test-secret")
    monkeypatch.delenv("HTTPS_PROXY", raising=False)
    monkeypatch.delenv("https_proxy", raising=False)
    state = {"responses": [], "sent": [], "closed": 0, "delays": []}

    class Connection:
        def __init__(self, *args, **kwargs):
            self.response = state["responses"].pop(0)
            self.status = self.response[0]
            self.stream = None
            if len(self.response) == 3:
                wire = self.response[2]

                class Socket:
                    def makefile(self, mode):
                        return io.BytesIO(wire)

                self.stream = http.client.HTTPResponse(Socket())
                self.stream.begin()

        def request(self, method, path, body, headers):
            state["sent"].append(json.loads(body))

        def getresponse(self):
            return self.stream or self

        def getheader(self, name):
            return self.response[1] if name.lower() == "retry-after" else None

        def read(self, limit):
            if state.get("readError"):
                raise TimeoutError("response read timed out")
            # Return the body once, then EOF, like a real response.
            if getattr(self, "body_read", False):
                return b""
            self.body_read = True
            if self.status != 200:
                return b'{"error":{"message":"retry-test-secret provider busy"}}'
            return json.dumps(
                {
                    "choices": [
                        {
                            "finish_reason": "stop",
                            "message": {"content": '{"score":1,"reason":"Grounded"}'},
                        }
                    ]
                }
            ).encode()

        def close(self):
            if self.stream:
                self.stream.close()
            state["closed"] += 1

    def sleep(seconds):
        assert judge_runtime._openrouter_request.get() is None
        assert state["closed"] == len(state["sent"])
        state["delays"].append(seconds)

    monkeypatch.setattr(http.client, "HTTPSConnection", Connection)
    monkeypatch.setattr(time, "sleep", sleep, raising=False)
    monkeypatch.setattr(random, "uniform", lambda low, high: high, raising=False)
    return state


def test_429_retries_preserve_identical_request_and_redacted_attempts(http_sequence):
    http_sequence["responses"] = [(429, None), (429, "7"), (200, None)]
    judge = adapter.OpenRouterJudge()
    assert judge.generate("Evaluate", Verdict).score == 1
    assert http_sequence["delays"] == [5, 7]
    assert len(http_sequence["sent"]) == 3
    assert all(body == http_sequence["sent"][0] for body in http_sequence["sent"])
    assert [r["httpStatus"] for r in judge.requests] == [429, 429, 200]
    assert [r["attempt"] for r in judge.requests] == [1, 2, 3]
    assert len({r["logicalRequest"] for r in judge.requests}) == 1
    assert judge.requests[-1]["completed"] is True
    assert "retry-test-secret" not in json.dumps(judge.requests)


def test_retry_budget_stops_after_four_attempts_and_preserves_error(http_sequence):
    http_sequence["responses"] = [(429, None)] * 5
    with pytest.raises(JudgeError, match="429") as caught:
        grading.judge_answer("Question", "Answer", "Reference")
    calls = caught.value.calls
    assert len(calls) == 4
    assert http_sequence["delays"] == [5, 9, 17]
    assert len(http_sequence["responses"]) == 1
    assert calls[-1]["retryExhausted"] is True
    assert "retryDelaySeconds" not in calls[-1]


@pytest.mark.parametrize(
    "header,expected", [("garbage", 5), ("-1", 5), ("0", 0), ("60", 60)]
)
def test_retry_after_seconds_and_invalid_headers(http_sequence, header, expected):
    http_sequence["responses"] = [(429, header), (200, None)]
    adapter.OpenRouterJudge().generate("Evaluate", Verdict)
    assert http_sequence["delays"] == [expected]


def test_retry_after_http_date_uses_remaining_time(monkeypatch, http_sequence):
    monkeypatch.setattr(time, "time", lambda: 1_800_000_000)
    date = format_datetime(datetime.fromtimestamp(1_800_000_012, UTC), usegmt=True)
    http_sequence["responses"] = [(429, date), (200, None)]
    adapter.OpenRouterJudge().generate("Evaluate", Verdict)
    assert http_sequence["delays"] == [12]


def test_retry_after_above_wait_budget_fails_without_retrying_early(http_sequence):
    http_sequence["responses"] = [(429, "61"), (200, None)]
    judge = adapter.OpenRouterJudge()
    with pytest.raises(RuntimeError, match="429"):
        judge.generate("Evaluate", Verdict)
    assert len(judge.requests) == 1
    assert http_sequence["delays"] == []
    assert judge.requests[0]["retrySkipped"] == "retry-after-exceeds-wait-budget"


def test_retry_wait_past_request_deadline_fails_without_waiting(
    monkeypatch, http_sequence
):
    monkeypatch.setitem(transport.RETRY_POLICY, "requestDeadlineSeconds", 20)
    http_sequence["responses"] = [(429, "30"), (200, None)]
    judge = adapter.OpenRouterJudge()
    with pytest.raises(RuntimeError, match="429"):
        judge.generate("Evaluate", Verdict)
    assert len(judge.requests) == 1
    assert http_sequence["delays"] == []
    assert judge.requests[0]["retrySkipped"] == "retry-exceeds-request-deadline"


def test_trickling_response_stops_at_total_deadline(monkeypatch):
    # Each read arrives within the socket timeout; only the total deadline ends it.
    monkeypatch.setenv("OPENROUTER_API_KEY", "offline-test-key")
    monkeypatch.delenv("HTTPS_PROXY", raising=False)
    monkeypatch.delenv("https_proxy", raising=False)
    monkeypatch.setitem(transport.RETRY_POLICY, "requestDeadlineSeconds", 10)
    clock = {"now": 0.0, "reads": 0}
    monkeypatch.setattr(time, "monotonic", lambda: clock["now"])

    class Trickle:
        status = 200
        length = 1_000

        def __init__(self, *args, **kwargs):
            pass

        def request(self, *args):
            pass

        def getresponse(self):
            return self

        def read(self, limit):
            clock["now"] += 1
            clock["reads"] += 1
            return b"x"

        def close(self):
            pass

    monkeypatch.setattr(http.client, "HTTPSConnection", Trickle)
    monkeypatch.setattr(time, "sleep", lambda seconds: pytest.fail("No retry"))
    with pytest.raises(JudgeError, match="total deadline") as caught:
        grading.judge_answer("Question", "Answer", "Reference")
    calls = caught.value.calls
    assert len(calls) == 1
    assert calls[0]["deadlineExceeded"] is True
    assert calls[0]["responseComplete"] is False
    assert calls[0]["rawResponse"] == "x" * clock["reads"]
    assert clock["reads"] == 10


@pytest.mark.parametrize("status", [400, 401, 402, 403, 404, 501])
def test_other_http_errors_are_never_retried(http_sequence, status):
    http_sequence["responses"] = [(status, None), (200, None)]
    with pytest.raises(RuntimeError, match=str(status)):
        adapter.OpenRouterJudge().generate("Evaluate", Verdict)
    assert len(http_sequence["sent"]) == 1
    assert http_sequence["delays"] == []


def test_report_separates_recovered_limits_from_exhausted_errors(monkeypatch, tmp_path):
    from copy import deepcopy

    cases = collection.load_cases()[:3]
    count_expected = len(cases)
    monkeypatch.setattr(collection, "load_cases", lambda categories: cases)
    monkeypatch.setattr(collection, "judge_metadata", lambda: ({}, {}))
    count = 0

    def judge(*args):
        nonlocal count
        count += 1
        calls = [
            {"logicalRequest": 1, "attempt": 1, "httpStatus": 429},
            {"logicalRequest": 1, "attempt": 2, "httpStatus": 200, "completed": True},
        ]
        if count == 2:
            calls[-1].update(httpStatus=429, completed=False, retryExhausted=True)
            error = RuntimeError("Judge HTTP failure: 429")
            raise JudgeError(error, deepcopy(calls)) from error
        return {
            "passed": True,
            "dimensions": dict.fromkeys(adapter_summary_dimensions, True),
            "calls": calls,
        }

    adapter_summary_dimensions = ("factualSupport", "taskCompleteness", "answerQuality")
    monkeypatch.setattr(collection, "judge_answer", judge)
    assert collection.run_collection({}, tmp_path / "report.json") == 1
    report = json.loads((tmp_path / "report.json").read_text())
    summary = report["requests"]
    assert summary["requestAttempts"] == count_expected * 2
    assert summary["retryAttempts"] == count_expected
    assert summary["rateLimitedAttempts"] == count_expected + 1
    assert summary["recoveredRateLimitedRequests"] == count_expected - 1
    assert summary["unresolvedRateLimitedRequests"] == 1
    assert report["summary"]["checks"]["error"] == 1
    assert report["metadata"]["retryPolicy"]["maxRetries"] == 3
    assert len(report["results"][1]["checks"][0]["actual"]["calls"]) == 2


def test_response_read_failure_is_not_retried_even_after_429_status(http_sequence):
    http_sequence["responses"] = [(429, "1"), (200, None)]
    http_sequence["readError"] = True
    with pytest.raises(TimeoutError):
        adapter.OpenRouterJudge().generate("Evaluate", Verdict)
    assert len(http_sequence["sent"]) == 1
    assert http_sequence["delays"] == []


def test_premature_http_body_eof_is_not_retried(monkeypatch, http_sequence):
    class Socket:
        def makefile(self, mode):
            return io.BytesIO(
                b"HTTP/1.1 429 Too Many Requests\r\nContent-Length: 100\r\n\r\npartial"
            )

    response = http.client.HTTPResponse(Socket())
    response.begin()

    class Connection:
        def __init__(self, *args, **kwargs):
            pass

        def request(self, method, path, body, headers):
            http_sequence["sent"].append(json.loads(body))

        def getresponse(self):
            return response

        def close(self):
            response.close()
            http_sequence["closed"] += 1

    monkeypatch.setattr(http.client, "HTTPSConnection", Connection)
    judge = adapter.OpenRouterJudge()
    with pytest.raises(RuntimeError, match="429"):
        judge.generate("Evaluate", Verdict)
    assert len(judge.requests) == 1
    assert http_sequence["delays"] == []
    assert judge.requests[0]["rawResponse"] == "partial"
    assert judge.requests[0]["responseComplete"] is False


CHUNKED_PARTIAL = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n11\r\nretry-test-secret\r\n8\r\nshort"
LENGTH_PARTIAL = b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nretry-test-secret"


@pytest.mark.parametrize("wire", [CHUNKED_PARTIAL, LENGTH_PARTIAL])
def test_incomplete_200_response_retries_identical_request_with_partial_evidence(
    http_sequence, wire
):
    http_sequence["responses"] = [(200, None, wire), (200, None)]
    judge = adapter.OpenRouterJudge()
    assert judge.generate("Evaluate", Verdict).score == 1
    assert len(judge.requests) == 2
    first, last = judge.requests
    assert first["responseComplete"] is False
    assert first["responseBytes"] > 0
    assert "[REDACTED]" in first["rawResponse"]
    assert "retry-test-secret" not in json.dumps(judge.requests)
    assert first["retryReason"] == "incomplete-response"
    assert http_sequence["sent"][0] == http_sequence["sent"][1]
    assert last["completed"] is True
    summary = summarize_requests([{"calls": judge.requests}])
    assert summary["recoveredIncompleteResponseRequests"] == 1
    assert summary["unresolvedIncompleteResponseRequests"] == 0
    assert summary["rateLimitedAttempts"] == 0


def test_mixed_incomplete_and_rate_limit_failures_share_one_retry_budget(http_sequence):
    http_sequence["responses"] = [
        (200, None, CHUNKED_PARTIAL),
        (429, None),
        (200, None, LENGTH_PARTIAL),
        (200, None, CHUNKED_PARTIAL),
        (200, None),
    ]
    judge = adapter.OpenRouterJudge()
    with pytest.raises(http.client.IncompleteRead):
        judge.generate("Evaluate", Verdict)
    assert len(judge.requests) == 4
    assert judge.requests[-1]["retryExhausted"] is True
    assert http_sequence["delays"] == [5, 9, 17]
    assert len(http_sequence["responses"]) == 1
    assert all(body == http_sequence["sent"][0] for body in http_sequence["sent"])
    summary = summarize_requests([{"calls": judge.requests}])
    assert summary["unresolvedIncompleteResponseRequests"] == 1
    assert summary["unresolvedRateLimitedRequests"] == 1


@pytest.mark.parametrize(
    "wire",
    [
        b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 100\r\n\r\npartial",
        b"HTTP/1.1 429 Too Many Requests\r\nTransfer-Encoding: chunked\r\n\r\n8\r\npartial",
    ],
)
def test_incomplete_non_success_response_remains_terminal(http_sequence, wire):
    http_sequence["responses"] = [
        (401 if b"401" in wire else 429, None, wire),
        (200, None),
    ]
    judge = adapter.OpenRouterJudge()
    with pytest.raises((RuntimeError, http.client.IncompleteRead)):
        judge.generate("Evaluate", Verdict)
    assert len(judge.requests) == 1
    assert http_sequence["delays"] == []
    assert judge.requests[0]["responseComplete"] is False


def error_response(code, *, choice=False, retry_after=None):
    error = {
        "message": "retry-test-secret provider unavailable",
        "code": code,
        "metadata": {"error_type": "provider_unavailable"},
    }
    payload = {"choices": [{"error": error}]} if choice else {"error": error}
    body = json.dumps(payload).encode()
    headers = f"HTTP/1.1 200 OK\r\nContent-Length: {len(body)}\r\n"
    if retry_after is not None:
        headers += f"Retry-After: {retry_after}\r\n"
    return (200, None, headers.encode() + b"\r\n" + body)


@pytest.mark.parametrize("status", [500, 502, 503, 504])
def test_transient_http_errors_recover_automatically(http_sequence, status):
    http_sequence["responses"] = [(status, "7"), (200, None)]
    judge = adapter.OpenRouterJudge()
    assert judge.generate("Evaluate", Verdict).score == 1
    assert http_sequence["delays"] == [7]
    assert http_sequence["sent"][0] == http_sequence["sent"][1]
    assert judge.requests[0]["retryReason"] == "provider-error"
    summary = summarize_requests([{"calls": judge.requests}])
    assert summary["providerErrorAttempts"] == 1
    assert summary["recoveredProviderErrorRequests"] == 1
    assert summary["unresolvedProviderErrorRequests"] == 0


@pytest.mark.parametrize("code", [429, 500, 502, 503, 504])
@pytest.mark.parametrize("choice", [False, True])
def test_embedded_provider_errors_recover_with_evidence(http_sequence, code, choice):
    http_sequence["responses"] = [error_response(code, choice=choice), (200, None)]
    judge = adapter.OpenRouterJudge()
    assert judge.generate("Evaluate", Verdict).score == 1
    first, last = judge.requests
    assert first["httpStatus"] == 200
    assert first["upstreamStatus"] == code
    assert first["responseComplete"] is True
    assert last["completed"] is True
    assert first["logicalRequest"] == last["logicalRequest"]
    assert http_sequence["sent"][0] == http_sequence["sent"][1]
    assert http_sequence["delays"] == [5]
    assert "retry-test-secret" not in json.dumps(judge.requests)
    summary = summarize_requests([{"calls": judge.requests}])
    if code == 429:
        assert summary["rateLimitedAttempts"] == 1
        assert summary["recoveredRateLimitedRequests"] == 1
        assert summary["providerErrorAttempts"] == 0
    else:
        assert summary["providerErrorAttempts"] == 1
        assert summary["recoveredProviderErrorRequests"] == 1


@pytest.mark.parametrize("code", [400, 401, 402, 403, 501, "502", None])
def test_non_transient_or_unclassified_embedded_errors_are_terminal(
    http_sequence, code
):
    http_sequence["responses"] = [error_response(code), (200, None)]
    judge = adapter.OpenRouterJudge()
    with pytest.raises(RuntimeError, match="upstream error"):
        judge.generate("Evaluate", Verdict)
    assert len(judge.requests) == 1
    assert http_sequence["delays"] == []


def test_embedded_error_honors_retry_after_wait_limit(http_sequence):
    http_sequence["responses"] = [error_response(502, retry_after="61"), (200, None)]
    judge = adapter.OpenRouterJudge()
    with pytest.raises(RuntimeError, match="upstream error"):
        judge.generate("Evaluate", Verdict)
    assert len(judge.requests) == 1
    assert judge.requests[0]["retrySkipped"] == "retry-after-exceeds-wait-budget"
    assert http_sequence["delays"] == []


def test_all_transient_failures_share_one_budget_in_deepeval(http_sequence):
    http_sequence["responses"] = [
        (200, None, CHUNKED_PARTIAL),
        (429, None),
        (503, None),
        error_response(502),
        (200, None),
    ]
    with pytest.raises(JudgeError, match="upstream error") as caught:
        grading.judge_answer("Question", "Answer", "Reference")
    calls = caught.value.calls
    assert len(calls) == 4
    assert calls[-1]["retryExhausted"] is True
    assert http_sequence["delays"] == [5, 9, 17]
    assert len(http_sequence["responses"]) == 1
    assert all(body == http_sequence["sent"][0] for body in http_sequence["sent"])
    summary = summarize_requests([{"calls": calls}])
    assert summary["providerErrorAttempts"] == 2
    assert summary["unresolvedProviderErrorRequests"] == 1
    assert summary["recoveredProviderErrorRequests"] == 0
    assert summary["unresolvedRateLimitedRequests"] == 1
    assert summary["unresolvedIncompleteResponseRequests"] == 1


@pytest.mark.parametrize("expected_passed", [True, False])
def test_collection_recovers_mid_evaluation_without_repeating_grades(
    monkeypatch, tmp_path, http_sequence, expected_passed
):
    cases = collection.load_cases()[:1]
    cases[0]["checks"]["answer"]["passed"] = expected_passed
    monkeypatch.setattr(collection, "load_cases", lambda categories: cases)
    http_sequence["responses"] = [
        (200, None),
        error_response(502),
        (200, None),
        (200, None),
    ]
    destination = tmp_path / "report.json"
    assert collection.run_collection({}, destination) == (0 if expected_passed else 1)
    report = json.loads(destination.read_text())
    assert report["summary"]["checks"] == {
        "passed": int(expected_passed),
        "failed": int(not expected_passed),
        "error": 0,
        "pending": 0,
    }
    calls = report["results"][0]["checks"][0]["actual"]["calls"]
    assert len(calls) == 4
    assert [call["attempt"] for call in calls] == [1, 1, 2, 1]
    assert calls[1]["request"] == calls[2]["request"]
    assert report["requests"]["retryAttempts"] == 1
    assert report["requests"]["recoveredProviderErrorRequests"] == 1
    assert report["requests"]["unresolvedProviderErrorRequests"] == 0
    assert report["metadata"]["retryPolicy"]["upstreamStatuses"] == [
        429,
        500,
        502,
        503,
        504,
    ]
    assert "retry-test-secret" not in destination.read_text()
