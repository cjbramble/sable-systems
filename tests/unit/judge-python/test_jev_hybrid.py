"""Run native DeepEval and TypeSafe SDK code against a controlled HTTPS boundary."""

import http.client
import json

import pytest

import support_grading as grading


@pytest.fixture
def wire(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "offline-jev-key")
    monkeypatch.setenv("OPENROUTER_JUDGE_MODEL", "openai/gpt-6-luna")
    monkeypatch.setenv("OPENROUTER_FAITHFULNESS_MODE", "hybrid")
    monkeypatch.delenv("HTTPS_PROXY", raising=False)
    monkeypatch.delenv("https_proxy", raising=False)
    state = {"probability": 0.9, "requests": [], "status": 200}

    class Connection:
        def __init__(self, host, port, timeout):
            assert (host, port) == ("openrouter.ai", 443)

        def request(self, method, path, body, headers):
            self.path = path
            self.body = json.loads(body)
            state["requests"].append((path, self.body))
            assert headers["Authorization"] == "Bearer offline-jev-key"

        def getresponse(self):
            self.status = state["status"] if self.path.endswith("systemone") else 200
            return self

        def read(self, limit):
            if self.path.endswith("systemone"):
                if state.get("truncated"):
                    raise http.client.IncompleteRead(b"{", 1)
                return json.dumps(
                    {
                        "model": "typesafe/jev-1.14",
                        "answers": {
                            key: {"type": "noul", "noul": state["probability"]}
                            for key in (
                                {}
                                if state.get("missing_answers")
                                else self.body["questions"]
                            )
                        },
                        "usage": {
                            "input_tokens": 100,
                            "output_tokens": 0,
                            "cost": 0.0000042,
                        },
                    }
                ).encode()
            schema = self.body["response_format"]["json_schema"]["schema"]
            fields = schema["properties"]
            if "claims" in fields:
                data = {"claims": ["47 units."]}
            elif "truths" in fields:
                data = {"truths": ["47 units available."]}
            elif "verdicts" in fields:
                data = {"verdicts": [{"verdict": "yes", "reason": "Supported."}]}
            elif "score" in fields:
                data = {"score": 1, "reason": "Supported."}
            else:
                data = {"reason": "Supported."}
            return json.dumps(
                {
                    "choices": [
                        {
                            "finish_reason": "stop",
                            "message": {"content": json.dumps(data)},
                        }
                    ]
                }
            ).encode()

        def close(self):
            pass

    monkeypatch.setattr(http.client, "HTTPSConnection", Connection)
    return state


@pytest.mark.parametrize(
    "probability,verdict,passed",
    [(0.9, "yes", True), (0.5, "idk", False), (0.1, "no", False)],
)
def test_hybrid_uses_jev_for_verdicts_and_luna_for_extraction(
    wire, probability, verdict, passed
):
    wire["probability"] = probability
    result = grading.judge_claims("Stock?", "47 units.", "47 units available.")
    assert result["passed"] is passed
    assert result["verdicts"][0]["verdict"] == verdict
    assert result["faithfulness"]["mode"] == "hybrid"
    assert result["faithfulness"]["fallbackReason"] is None
    assert result["faithfulness"]["confidence"] == pytest.approx(
        abs(2 * probability - 1)
    )
    decisions = [body for path, body in wire["requests"] if path.endswith("systemone")]
    assert len(decisions) == 1
    assert decisions[0]["model"] == "typesafe/jev-1.14"
    assert decisions[0]["state"]["retrieval_context"] == ["47 units available."]
    assert result["faithfulness"]["nativeVerdicts"][0]["verdict"] == (
        "borderline" if verdict == "idk" else verdict
    )
    assert len(result["calls"]) == 4
    assert "offline-jev-key" not in json.dumps(result)


def test_hybrid_records_fallback_and_keeps_failed_request_evidence(wire):
    wire["status"] = 503
    result = grading.judge_claims("Stock?", "47 units.", "47 units available.")
    assert result["passed"]
    assert result["faithfulness"]["fallbackReason"]
    assert any(call.get("httpStatus") == 503 for call in result["calls"])
    assert len(wire["requests"]) == 5


def test_hybrid_does_not_change_whole_answer_geval(wire):
    result = grading.judge_answer("Stock?", "47 units.", "47 units available.")
    assert result["passed"]
    assert len(wire["requests"]) == 3
    assert all(path.endswith("chat/completions") for path, _ in wire["requests"])


def test_llm_mode_never_calls_jev(wire, monkeypatch):
    monkeypatch.setenv("OPENROUTER_FAITHFULNESS_MODE", "llm")
    result = grading.judge_claims("Stock?", "47 units.", "47 units available.")
    assert result["passed"]
    assert result["faithfulness"]["mode"] == "llm"
    assert all(path.endswith("chat/completions") for path, _ in wire["requests"])


def test_invalid_mode_fails_before_requests(wire, monkeypatch):
    monkeypatch.setenv("OPENROUTER_FAITHFULNESS_MODE", "hybird")
    with pytest.raises(ValueError, match="OPENROUTER_FAITHFULNESS_MODE"):
        grading.judge_claims("Stock?", "47 units.", "47 units available.")
    assert not wire["requests"]


@pytest.mark.parametrize("defect", ["invalid-probability", "missing-answers"])
def test_invalid_jev_response_is_not_recorded_as_completed(wire, defect):
    if defect == "invalid-probability":
        wire["probability"] = 1.5
    else:
        wire["missing_answers"] = True
    result = grading.judge_claims("Stock?", "47 units.", "47 units available.")
    assert result["faithfulness"]["fallbackReason"]
    call = next(c for c in result["calls"] if c["endpoint"].endswith("systemone"))
    assert not call.get("completed", False)
    assert call["errorType"]
    assert call["response"]


def test_exhausted_incomplete_jev_responses_fall_back_to_luna(wire, monkeypatch):
    import openrouter_transport

    wire["truncated"] = True
    monkeypatch.setattr(openrouter_transport.time, "sleep", lambda delay: None)
    result = grading.judge_claims("Stock?", "47 units.", "47 units available.")
    assert result["passed"]
    assert result["faithfulness"]["fallbackReason"]
    attempts = [c for c in result["calls"] if c["endpoint"].endswith("systemone")]
    assert len(attempts) == 4
    assert attempts[-1]["retryExhausted"]
    assert all(not c.get("completed", False) for c in attempts)
