import json
from typing import Literal

import pytest
from pydantic import BaseModel

import openrouter_judge
import support_grading as grading
from judge_errors import JudgeError


@pytest.fixture(autouse=True)
def offline_credentials(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "offline-test-key")
    monkeypatch.delenv("HTTPS_PROXY", raising=False)
    monkeypatch.delenv("https_proxy", raising=False)
    monkeypatch.delenv("OPENROUTER_JUDGE_MODEL", raising=False)
    monkeypatch.delenv("OPENROUTER_JUDGE_REASONING", raising=False)
    monkeypatch.delenv("OPENROUTER_JUDGE_MAX_TOKENS", raising=False)
    monkeypatch.delenv("OPENROUTER_JUDGE_REASONING_EFFORT", raising=False)


class Verdict(BaseModel):
    score: Literal[0, 1]
    reason: str


@pytest.fixture
def transport(monkeypatch):
    state = {
        "status": 200,
        "finish": "stop",
        "content": '{"score":1,"reason":"Grounded"}',
    }

    class Connection:
        def __init__(self, host, port, timeout):
            state["destination"] = (host, port, timeout)

        def set_tunnel(self, host, port):
            state["tunnel"] = (host, port)

        def request(self, method, path, body, headers):
            state["request"] = (method, path, json.loads(body), headers)

        def getresponse(self):
            self.status = state["status"]
            return self

        def read(self, limit):
            content = (
                state["responses"].pop(0) if "responses" in state else state["content"]
            )
            return json.dumps(
                {
                    "choices": [
                        {
                            "finish_reason": state["finish"],
                            "message": {"content": content},
                        }
                    ]
                }
            ).encode()

        def close(self):
            state["closed"] = True

    monkeypatch.setattr(openrouter_judge.http.client, "HTTPSConnection", Connection)
    return state


def test_openrouter_judge_uses_https_schema_routing_without_recording_credentials(
    monkeypatch, transport
):
    monkeypatch.setenv("OPENROUTER_API_KEY", "offline-test-key")
    judge = openrouter_judge.OpenRouterJudge()
    assert judge.generate("Evaluate this answer", Verdict).score == 1
    assert transport["destination"] == ("openrouter.ai", 443, 180)
    method, path, body, headers = transport["request"]
    assert (method, path) == ("POST", "/api/v1/chat/completions")
    assert headers["Authorization"] == "Bearer offline-test-key"
    assert body["model"] == "z-ai/glm-5.3-flash"
    assert body["provider"] == {
        "allow_fallbacks": False,
        "require_parameters": True,
        "data_collection": "deny",
        "zdr": True,
    }
    assert body["reasoning"] == {"enabled": True, "effort": "high"}
    assert body["max_tokens"] == 16384
    assert "seed" not in body and "chat_template_kwargs" not in body
    assert body["response_format"]["json_schema"]["strict"] is True
    assert "offline-test-key" not in json.dumps(judge.requests)
    assert openrouter_judge._openrouter_request.get() is None
    assert transport["closed"] is True


def test_openrouter_judge_comparison_overrides_reach_the_request(
    monkeypatch, transport
):
    monkeypatch.setenv("OPENROUTER_API_KEY", "offline-test-key")
    monkeypatch.setenv("OPENROUTER_JUDGE_REASONING", "false")
    monkeypatch.setenv("OPENROUTER_JUDGE_MAX_TOKENS", "4096")
    openrouter_judge.OpenRouterJudge().generate("Evaluate", Verdict)
    body = transport["request"][2]
    assert body["reasoning"] == {"enabled": False}
    assert body["max_tokens"] == 4096


@pytest.mark.parametrize("effort", ["low", "high", "max"])
def test_explicit_reasoning_effort_reaches_request_without_changing_model_or_budget(
    monkeypatch, transport, effort
):
    monkeypatch.setenv("OPENROUTER_JUDGE_REASONING_EFFORT", effort)
    openrouter_judge.OpenRouterJudge().generate("Evaluate", Verdict)
    body = transport["request"][2]
    assert body["reasoning"] == {"enabled": True, "effort": effort}
    assert body["model"] == "z-ai/glm-5.3-flash"
    assert body["max_tokens"] == 16384
    assert body["provider"]["require_parameters"] is True


@pytest.mark.parametrize("effort", ["medium", "none", "unbounded"])
def test_unsupported_glm_reasoning_effort_fails_before_connecting(
    monkeypatch, transport, effort
):
    monkeypatch.setenv("OPENROUTER_JUDGE_REASONING_EFFORT", effort)
    with pytest.raises(ValueError, match="OPENROUTER_JUDGE_REASONING_EFFORT"):
        openrouter_judge.OpenRouterJudge()
    assert "destination" not in transport


def test_explicit_effort_cannot_be_silently_ignored_when_reasoning_is_disabled(
    monkeypatch, transport
):
    monkeypatch.setenv("OPENROUTER_JUDGE_REASONING", "false")
    monkeypatch.setenv("OPENROUTER_JUDGE_REASONING_EFFORT", "high")
    with pytest.raises(ValueError, match="OPENROUTER_JUDGE_REASONING_EFFORT"):
        openrouter_judge.OpenRouterJudge()
    assert "destination" not in transport


def test_alternate_model_keeps_its_own_default_effort(monkeypatch, transport):
    monkeypatch.setenv("OPENROUTER_JUDGE_MODEL", "qwen/qwen3.8-27b")
    openrouter_judge.OpenRouterJudge().generate("Evaluate", Verdict)
    assert transport["request"][2]["reasoning"] == {"enabled": True}


@pytest.mark.parametrize("effort", ["medium", "xhigh"])
def test_alternate_model_can_use_standard_explicit_efforts(
    monkeypatch, transport, effort
):
    monkeypatch.setenv("OPENROUTER_JUDGE_MODEL", "qwen/qwen3.8-27b")
    monkeypatch.setenv("OPENROUTER_JUDGE_REASONING_EFFORT", effort)
    openrouter_judge.OpenRouterJudge().generate("Evaluate", Verdict)
    assert transport["request"][2]["reasoning"] == {"enabled": True, "effort": effort}


@pytest.mark.parametrize(
    "name,value",
    [
        ("OPENROUTER_JUDGE_REASONING", "yes"),
        ("OPENROUTER_JUDGE_MAX_TOKENS", "255"),
        ("OPENROUTER_JUDGE_MAX_TOKENS", "32769"),
        ("OPENROUTER_JUDGE_MAX_TOKENS", "4096.5"),
    ],
)
def test_invalid_hosted_judge_settings_fail_before_a_request(
    monkeypatch, transport, name, value
):
    monkeypatch.setenv(name, value)
    with pytest.raises(ValueError, match=name):
        openrouter_judge.OpenRouterJudge()
    assert "destination" not in transport


def test_truncated_reasoning_verdict_retains_evidence_and_cannot_pass(
    monkeypatch, transport
):
    monkeypatch.setenv("OPENROUTER_API_KEY", "offline-test-key")
    transport.update({"finish": "length", "content": ""})
    with pytest.raises(JudgeError, match="did not finish") as caught:
        grading.judge_answer("Question", "Answer", "Reference")
    assert len(caught.value.calls) == 1
    assert caught.value.calls[0]["response"]["choices"][0]["finish_reason"] == "length"
    assert "offline-test-key" not in json.dumps(caught.value.calls)
    assert openrouter_judge._openrouter_request.get() is None
    assert transport["closed"] is True


def test_openrouter_judge_requires_a_key_before_connecting(monkeypatch, transport):
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    with pytest.raises(ValueError, match="OPENROUTER_API_KEY"):
        openrouter_judge.OpenRouterJudge().generate("Evaluate", Verdict)
    assert "destination" not in transport


def test_openrouter_failures_reset_network_scope_without_logging_credentials(
    monkeypatch, transport
):
    monkeypatch.setenv("OPENROUTER_API_KEY", "offline-test-key")
    transport["status"] = 401
    judge = openrouter_judge.OpenRouterJudge()
    with pytest.raises(RuntimeError, match="Judge HTTP failure: 401"):
        judge.generate("Evaluate", Verdict)
    assert len(judge.requests) == 1
    assert judge.requests[0]["httpStatus"] == 401
    assert "offline-test-key" not in json.dumps(judge.requests)
    assert openrouter_judge._openrouter_request.get() is None


def test_openrouter_network_scope_permits_only_fixed_dns_and_resolved_https_addresses():
    destination = ("198.51.100.1", 443)
    token = openrouter_judge._openrouter_request.set({destination})
    try:
        openrouter_judge.restrict_network("socket.getaddrinfo", ("openrouter.ai", 443))
        openrouter_judge.restrict_network("socket.connect", (None, destination))
        with pytest.raises(PermissionError):
            openrouter_judge.restrict_network(
                "socket.getaddrinfo", ("example.com", 443)
            )
        with pytest.raises(PermissionError):
            openrouter_judge.restrict_network(
                "socket.connect", (None, ("198.51.100.2", 443))
            )
    finally:
        openrouter_judge._openrouter_request.reset(token)


def test_openrouter_metadata_has_no_local_weights_or_local_generation_parameters(
    monkeypatch,
):
    metadata, generation = openrouter_judge.judge_metadata()
    assert metadata == {"provider": "openrouter", "alias": "z-ai/glm-5.3-flash"}
    assert "seed" not in generation and "chat_template_kwargs" not in generation


def test_current_grading_uses_fixed_rules_in_one_structured_judgment(transport):
    transport["content"] = json.dumps(
        {
            "facts": [
                {"claim": "Candidate answer", "verdict": "yes", "reason": "Grounded"}
            ],
            "requirements": [
                {
                    "requirement": "Customer question",
                    "status": "supplied",
                    "reason": "Complete",
                }
            ],
            "quality": dict(
                evaluator_instruction=False,
                off_topic=False,
                unauthorized_action=False,
                foreign_account_disclosure=False,
                invented_resource=False,
                reason="Clear",
            ),
        }
    )
    result = grading.judge_answer(
        "Customer question", "Candidate answer", "Authoritative facts"
    )

    assert result["passed"] is True
    assert len(result["calls"]) == 1
    body = result["calls"][0]["request"]
    prompt = body["messages"][0]["content"]
    assert grading.ANSWER_RULES in prompt
    for text in ("Customer question", "Candidate answer", "Authoritative facts"):
        assert text in prompt
    assert body["temperature"] == 0
    assert body["reasoning"] == {"enabled": True, "effort": "high"}
    assert body["max_tokens"] == 16384
    assert "seed" not in body and "chat_template_kwargs" not in body
    assert result["score"] == 1


@pytest.mark.parametrize(
    "change",
    [
        {"status": 503},
        {"finish": "length"},
        {"content": "not json"},
        {"content": '{"score":9,"reason":"Invalid"}'},
    ],
)
def test_judge_errors_are_not_passing_verdicts(transport, change):
    transport.update(change)
    with pytest.raises((ValueError, RuntimeError)):
        openrouter_judge.OpenRouterJudge().generate("Evaluate", Verdict)
    assert transport["closed"] is True


@pytest.mark.parametrize(
    "address", [("example.com", 443), ("127.0.0.1", 8080), ("192.168.1.1", 8017)]
)
def test_network_guard_blocks_other_destinations(address):
    with pytest.raises(PermissionError, match="explicit OpenRouter request"):
        openrouter_judge.restrict_network("socket.connect", (None, address))


@pytest.mark.parametrize(
    "event,args",
    [
        ("socket.getaddrinfo", ("openrouter.ai", 443)),
        ("socket.getaddrinfo", ("127.0.0.1", 8017)),
        ("socket.connect", (None, ("127.0.0.1", 8017))),
    ],
)
def test_network_guard_blocks_all_network_outside_explicit_judging(event, args):
    with pytest.raises(PermissionError, match="explicit OpenRouter request"):
        openrouter_judge.restrict_network(event, args)


def test_blank_answers_are_rejected_before_calling_a_model():
    with pytest.raises(ValueError, match="nonempty"):
        grading.judge_answer("Question", " ", "Expected facts")


@pytest.mark.parametrize("verdict", ["yes", "no", "idk", None])
def test_claim_judging_retains_evidence_and_rejects_ambiguous_or_missing_verdicts(
    transport, verdict
):
    expected = "Available stock is 312 units."
    answer = "320 units can be supplied from current stock."
    claims = [answer, "A separate claim to verify after the first verdict."]
    # Scripted responses test the metric wiring, not the model's factual judgment.
    transport["responses"] = [
        json.dumps(value)
        for value in (
            {"claims": claims},
            {
                "verdicts": []
                if verdict is None
                else [{"verdict": verdict, "reason": "Test evidence"}]
            },
            {"verdicts": [{"verdict": "yes", "reason": None}]},
        )
    ]
    if verdict is None:
        with pytest.raises(JudgeError) as caught:
            grading.judge_claims("What can ship?", answer, expected)
        assert len(caught.value.calls) == 2
        return
    result = grading.judge_claims("What can ship?", answer, expected)
    assert result["passed"] is (verdict == "yes")
    assert result["reference"] == expected
    assert result["claims"] == claims
    assert result["verdicts"] == [
        {"verdict": verdict, "reason": "Test evidence"},
        {"verdict": "yes", "reason": None},
    ]
    assert len(result["calls"]) == 3
    extraction_prompt = result["calls"][0]["request"]["messages"][0]["content"]
    assert answer in extraction_prompt
    assert expected not in extraction_prompt
    for index, call in enumerate(result["calls"][1:]):
        prompt = call["request"]["messages"][0]["content"]
        assert expected in prompt
        assert claims[index] in prompt
        assert claims[1 - index] not in prompt
    assert not transport["responses"]


@pytest.mark.parametrize("claims", [[], [" "]])
def test_empty_claim_extraction_cannot_pass(transport, claims):
    transport["content"] = json.dumps({"claims": claims})
    with pytest.raises(JudgeError) as caught:
        grading.judge_claims("Question", "Answer", "Reference")
    assert len(caught.value.calls) == 1


@pytest.mark.parametrize(
    "verdict,reason,invalid",
    [
        ("yes", None, False),
        ("no", "Stock is insufficient", False),
        ("idk", "Not enough evidence", False),
        ("no", None, True),
        (None, None, True),
    ],
)
def test_direct_claim_verification_uses_one_call_and_the_unmodified_reference(
    transport, verdict, reason, invalid
):
    reference = "Redline has 312 units available. Orders must be multiples of eight."
    claim = "We can supply 320 Redline units from current stock."
    transport["content"] = json.dumps(
        {
            "verdicts": []
            if verdict is None
            else [{"verdict": verdict, "reason": reason}]
        }
    )
    if invalid:
        with pytest.raises(JudgeError) as caught:
            grading.judge_direct_claim("Stock question", claim, reference)
        assert len(caught.value.calls) == 1
        return
    result = grading.judge_direct_claim("Stock question", claim, reference)
    assert result["passed"] is (verdict == "yes")
    assert result["reference"] == reference
    assert result["claims"] == [claim]
    assert result["verdicts"] == [{"verdict": verdict, "reason": reason}]
    assert len(result["calls"]) == 1
    prompt = result["calls"][0]["request"]["messages"][0]["content"]
    assert reference in prompt
    assert claim in prompt


def test_judge_model_override_preserves_privacy_and_reasoning(monkeypatch, transport):
    monkeypatch.setenv("OPENROUTER_JUDGE_MODEL", " other/model ")
    openrouter_judge.OpenRouterJudge().generate("Evaluate", Verdict)
    body = transport["request"][2]
    assert body["model"] == "other/model"
    assert body["reasoning"] == {"enabled": True}
    assert body["provider"] == openrouter_judge.DEFAULTS["judgeProvider"]
    assert openrouter_judge.DEFAULTS["model"] == "deepseek/deepseek-v4.1-flash"
    assert openrouter_judge.DEFAULTS["provider"]["only"] == ["deepinfra/fp8"]


@pytest.mark.parametrize("kind", ["invalid-json", "upstream", "timeout", "oversized"])
def test_failed_transport_keeps_bounded_redacted_evidence(monkeypatch, transport, kind):
    class FailureConnection:
        def __init__(self, *args, **kwargs):
            pass

        def request(self, *args):
            if kind == "timeout":
                raise TimeoutError("connection failed")

        def getresponse(self):
            self.status = 200
            return self

        def read(self, limit):
            if kind == "invalid-json":
                return b"invalid offline-test-key"
            if kind == "oversized":
                return b"x" * limit
            return b'{"error":{"message":"offline-test-key"}}'

        def close(self):
            pass

    monkeypatch.setattr(
        openrouter_judge.http.client, "HTTPSConnection", FailureConnection
    )
    with pytest.raises((ValueError, RuntimeError, TimeoutError)) as caught:
        grading.judge_answer("Question", "Answer", "Reference")
    calls = caught.value.calls
    assert len(calls) == 1
    assert "offline-test-key" not in json.dumps(calls)
    assert calls[0]["errorType"]
    assert len(calls[0].get("rawResponse", "")) <= 2_000_000
    assert openrouter_judge._openrouter_request.get() is None


def test_cloud_proxy_tunnels_only_to_openrouter_and_resets_transport(
    monkeypatch, transport
):
    monkeypatch.setenv("HTTPS_PROXY", "http://proxy:8080")
    judge = openrouter_judge.OpenRouterJudge()
    assert judge.generate("Evaluate", Verdict).score == 1
    assert transport["destination"] == ("proxy", 8080, 180)
    assert transport["tunnel"] == ("openrouter.ai", 443)
    assert openrouter_judge._openrouter_transport.get() == ("openrouter.ai", 443)
    assert "Authorization" not in json.dumps(judge.requests)


@pytest.mark.parametrize(
    "proxy",
    ["https://proxy:8080", "http://name:secret@proxy:8080", "http://proxy/path"],
)
def test_invalid_proxy_configuration_fails_before_connection(
    monkeypatch, transport, proxy
):
    monkeypatch.setenv("HTTPS_PROXY", proxy)
    with pytest.raises(ValueError, match="proxy"):
        openrouter_judge.OpenRouterJudge().generate("Evaluate", Verdict)
    assert "destination" not in transport
