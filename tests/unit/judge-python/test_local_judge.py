import json
from typing import Literal

import pytest
from pydantic import BaseModel

import local_judge


class Verdict(BaseModel):
    score: Literal[0, 1]
    reason: str


@pytest.fixture
def transport(monkeypatch):
    state = {"status": 200, "finish": "stop", "content": '{"score":1,"reason":"Grounded"}'}

    class Connection:
        def __init__(self, host, port, timeout):
            state["destination"] = (host, port, timeout)

        def request(self, method, path, body, headers):
            state["request"] = (method, path, json.loads(body), headers)

        def getresponse(self):
            self.status = state["status"]
            return self

        def read(self, limit):
            content = state["responses"].pop(0) if "responses" in state else state["content"]
            return json.dumps({"choices": [{"finish_reason": state["finish"], "message": {"content": content}}]}).encode()

        def close(self):
            state["closed"] = True

    monkeypatch.setattr(local_judge.http.client, "HTTPConnection", Connection)
    return state


def test_judge_uses_only_local_schema_constrained_requests(transport):
    result = local_judge.LocalJudge().generate("Evaluate this answer", Verdict)
    assert result.score == 1
    assert result.reason == "Grounded"
    assert transport["destination"] == ("127.0.0.1", 8017, 180)
    method, path, body, _ = transport["request"]
    assert (method, path) == ("POST", "/v1/chat/completions")
    assert body["model"] == "customer-support-judge"
    assert body["response_format"]["json_schema"]["schema"] == Verdict.model_json_schema()
    assert body["chat_template_kwargs"] == {"enable_thinking": False}
    assert body["stream"] is False
    assert transport["closed"] is True


def test_deepeval_uses_the_fixed_rubric_in_one_binary_judgment(transport):
    result = local_judge.judge_answer("Customer question", "Candidate answer", "Authoritative facts")

    assert result["passed"] is True
    assert len(result["calls"]) == 1
    body = result["calls"][0]["request"]
    prompt = body["messages"][0]["content"]
    for step in local_judge.STEPS:
        assert step in prompt
    for text in ("Customer question", "Candidate answer", "Authoritative facts"):
        assert text in prompt
    assert body["temperature"] == 0
    assert body["seed"] == 42
    assert body["chat_template_kwargs"] == {"enable_thinking": False}
    assert result["score"] == 1


@pytest.mark.parametrize("change", [
    {"status": 503}, {"finish": "length"}, {"content": "not json"},
    {"content": '{"score":9,"reason":"Invalid"}'},
])
def test_judge_errors_are_not_passing_verdicts(transport, change):
    transport.update(change)
    with pytest.raises((ValueError, RuntimeError)):
        local_judge.LocalJudge().generate("Evaluate", Verdict)
    assert transport["closed"] is True


@pytest.mark.parametrize("address", [("example.com", 443), ("127.0.0.1", 8080), ("192.168.1.1", 8017)])
def test_network_guard_blocks_other_destinations(address):
    with pytest.raises(PermissionError, match="permits only"):
        local_judge.restrict_network("socket.connect", (None, address))


def test_network_guard_allows_only_the_registered_local_judge():
    local_judge.restrict_network("socket.connect", (None, ("127.0.0.1", 8017)))
    local_judge.restrict_network("socket.getaddrinfo", ("127.0.0.1", 8017))


def test_network_guard_blocks_external_dns_before_resolution():
    with pytest.raises(PermissionError, match="local judge resolution"):
        local_judge.restrict_network("socket.getaddrinfo", ("example.com", 443))


def test_blank_answers_are_rejected_before_calling_a_model():
    with pytest.raises(ValueError, match="nonempty"):
        local_judge.judge_answer("Question", " ", "Expected facts")


@pytest.mark.parametrize("verdict", ["yes", "no", "idk", None])
def test_claim_judging_retains_evidence_and_rejects_ambiguous_or_missing_verdicts(transport, verdict):
    expected = "Available stock is 312 units."
    answer = "320 units can be supplied from current stock."
    claims = [answer, "A separate claim to verify after the first verdict."]
    # Scripted responses test the metric wiring, not the model's factual judgment.
    transport["responses"] = [json.dumps(value) for value in (
        {"claims": claims},
        {"verdicts": [] if verdict is None else [{"verdict": verdict, "reason": "Test evidence"}]},
        {"verdicts": [{"verdict": "yes", "reason": None}]},
    )]
    if verdict is None:
        with pytest.raises(ValueError, match="exactly one verdict") as caught:
            local_judge.judge_claims("What can ship?", answer, expected)
        assert len(caught.value.judge_calls) == 2
        return
    result = local_judge.judge_claims("What can ship?", answer, expected)
    assert result["passed"] is (verdict == "yes")
    assert result["reference"] == expected
    assert result["claims"] == claims
    assert result["verdicts"] == [{"verdict": verdict, "reason": "Test evidence"}, {"verdict": "yes", "reason": None}]
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
    with pytest.raises(ValueError, match="nonempty extracted claims") as caught:
        local_judge.judge_claims("Question", "Answer", "Reference")
    assert len(caught.value.judge_calls) == 1


@pytest.mark.parametrize("verdict,reason,invalid", [
    ("yes", None, False), ("no", "Stock is insufficient", False),
    ("idk", "Not enough evidence", False), ("no", None, True),
    (None, None, True),
])
def test_direct_claim_verification_uses_one_call_and_the_unmodified_reference(transport, verdict, reason, invalid):
    reference = "Redline has 312 units available. Orders must be multiples of eight."
    claim = "We can supply 320 Redline units from current stock."
    transport["content"] = json.dumps({"verdicts": [] if verdict is None else [{"verdict": verdict, "reason": reason}]})
    if invalid:
        with pytest.raises(ValueError) as caught:
            local_judge.judge_direct_claim("Stock question", claim, reference)
        assert len(caught.value.judge_calls) == 1
        return
    result = local_judge.judge_direct_claim("Stock question", claim, reference)
    assert result["passed"] is (verdict == "yes")
    assert result["reference"] == reference
    assert result["claims"] == [claim]
    assert result["verdicts"] == [{"verdict": verdict, "reason": reason}]
    assert len(result["calls"]) == 1
    prompt = result["calls"][0]["request"]["messages"][0]["content"]
    assert reference in prompt
    assert claim in prompt
