import io
import json
import sys
import urllib.error

import pytest

import evaluate_decisions as decisions


class Response:
    status = 200
    def __init__(self, body):
        self.body = body
    def __enter__(self):
        return self
    def __exit__(self, *_):
        return False
    def read(self, _):
        return self.body


def sample():
    return {"id": "delivery", "reference": "No delivery date recorded."}, {"id": "unknown", "text": "Delivery tomorrow.", "expectedVerdict": "idk"}


def response(choice="idk"):
    return {"model": decisions.RESOLVED_MODEL, "provider": "TypeSafe",
            "answers": {"support": {"type": "choice", "choice": choice}}}


def mock_transport(monkeypatch, data):
    requests = []
    class Opener:
        def open(self, request, timeout):
            requests.append(request)
            return Response(json.dumps(data).encode())
    monkeypatch.setattr(decisions.urllib.request, "build_opener", lambda *_: Opener())
    return requests


def test_unsupported_claim_is_rejected_and_request_has_no_authored_label(monkeypatch):
    requests = mock_transport(monkeypatch, response())
    result = decisions.assess(*sample(), {"zdr": True, "allow_fallbacks": False}, "private-key")
    assert result["verdict"] == "idk" and not result["passed"] and result["agrees"]
    body = json.loads(requests[0].data)
    assert requests[0].full_url == decisions.ENDPOINT
    assert body["provider"]["only"] == ["typesafe"]
    assert set(body["state"]) == {"reference", "claim"}
    assert "expectedVerdict" not in json.dumps(body)
    assert "private-key" not in json.dumps(result)


@pytest.mark.parametrize("change", [
    {"model": "other-model"}, {"provider": "other-provider"},
    {"answers": {}}, {"answers": {"support": {"type": "choice", "choice": "unknown"}}},
    {"answers": {"support": {"type": "score", "choice": "yes"}}},
])
def test_invalid_or_substituted_decisions_are_errors(monkeypatch, change):
    data = response(); data.update(change)
    mock_transport(monkeypatch, data)
    result = decisions.assess(*sample(), {}, "private-key")
    assert "error" in result and "agrees" not in result
    assert result["httpStatus"] == 200 and "response" in result


def test_http_error_keeps_sanitized_evidence_without_retry(monkeypatch):
    calls = []
    class Opener:
        def open(self, request, timeout):
            calls.append(request)
            raise urllib.error.HTTPError(decisions.ENDPOINT, 401, "unauthorized", {}, io.BytesIO(b'private-key upstream'))
    monkeypatch.setattr(decisions.urllib.request, "build_opener", lambda *_: Opener())
    result = decisions.assess(*sample(), {}, "private-key")
    assert result["httpStatus"] == 401
    assert result["rawResponse"] == "[REDACTED] upstream"
    assert len(calls) == 1 and "passed" not in result


def test_redirects_cannot_forward_authentication():
    with pytest.raises(RuntimeError, match="must not redirect"):
        decisions.NoRedirect().redirect_request(None, None, 302, "", {}, "https://other.example")


def test_report_counts_exact_verdict_disagreement_separately_from_false_acceptance(monkeypatch, tmp_path):
    output = tmp_path / "decisions.json"
    monkeypatch.setenv("OPENROUTER_API_KEY", "private-key")
    monkeypatch.setattr(sys, "argv", ["evaluate_decisions.py", "--output", str(output)])
    def assess(scenario, row, policy, key):
        expected = row["expectedVerdict"]
        verdict = "no" if expected == "idk" else expected
        return {"scenario": scenario["id"], "id": row["id"], "expectedVerdict": expected,
                "verdict": verdict, "passed": verdict == "yes", "agrees": verdict == expected}
    monkeypatch.setattr(decisions, "assess", assess)
    assert decisions.main() == 1
    report = json.loads(output.read_text())
    assert report["expectedSamples"] == report["summary"]["processedSamples"] == 16
    assert report["summary"]["exactVerdictDisagreements"] == 1
    assert report["summary"]["falseAcceptances"] == 0
    assert report["executionSuccessful"] and not report["labelAgreementSuccessful"]
    assert len(output.with_suffix(".jsonl").read_text().splitlines()) == 17
