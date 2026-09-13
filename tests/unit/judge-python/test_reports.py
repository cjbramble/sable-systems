import io
import json
import sys

import pytest

import evaluate as evaluation


def run_report(monkeypatch, tmp_path, payload):
    output = tmp_path / "report.json"
    monkeypatch.setattr(sys, "argv", ["evaluate.py", "--output", str(output)])
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps(payload)))
    code = evaluation.main()
    return code, json.loads(output.read_text()), output.with_suffix(".jsonl")


@pytest.mark.parametrize("factual_passed,judge_passed,error,expected_code", [
    (True, True, False, 0),
    (True, False, False, 0),  # Live judgments remain advisory during the pilot.
    (False, True, False, 1),
    (True, True, True, 1),
])
def test_live_reports_preserve_factual_failures_and_judge_errors(
    monkeypatch, tmp_path, factual_passed, judge_passed, error, expected_code
):
    def judge(*args):
        if error:
            raise RuntimeError("Local model unavailable")
        return {"score": int(judge_passed), "passed": judge_passed, "reason": "Test verdict"}

    monkeypatch.setattr(evaluation, "judge_answer", judge)
    payload = {"mode": "transcript", "sourceTranscript": "original.log", "sourceSha256": "source-digest", "batches": {
        "case-pack": {"samples": [{"sample": 1, "answer": "Original answer", "passed": factual_passed}]},
    }}
    code, report, evidence = run_report(monkeypatch, tmp_path, payload)
    assert code == expected_code
    assert report["sourceSha256"] == "source-digest"
    result = report["results"][0]
    assert result["answer"] == "Original answer"
    assert result["factualPassed"] is factual_passed
    assert ("error" in result) is error
    assert json.loads(evidence.read_text().splitlines()[1]) == result


@pytest.mark.parametrize("validation_set,count", [("all", 30), ("holdout", 8)])
def test_validation_disagreement_fails_without_changing_the_authored_labels(monkeypatch, tmp_path, validation_set, count):
    calls = []

    def judge(*args):
        calls.append(args)
        return {"score": 1, "passed": True, "reason": "Always accepts"}

    monkeypatch.setattr(evaluation, "judge_answer", judge)
    code, report, _ = run_report(monkeypatch, tmp_path, {"mode": "validation", "validationSet": validation_set})
    assert code == 1
    assert len(report["results"]) == count
    assert report["validationSet"] == validation_set
    assert len(report["holdoutSha256"]) == 64
    assert report["holdoutFrozenAgainst"] == "54fe73b"
    assert len({(row["scenario"], row["id"]) for row in report["results"]}) == count
    assert sum(row["expectedPassed"] for row in report["results"]) == count // 2
    if validation_set == "holdout":
        assert all(row["id"].startswith("holdout-") for row in report["results"])
    for args, row in zip(calls, report["results"], strict=True):
        fixture = json.loads((evaluation.ROOT / f"tests/fixtures/judge/{row['scenario']}.json").read_text())
        # The judge sees the task, answer and reference, never the authored label or rationale.
        assert args == (fixture["question"], row["answer"], fixture["references"][0])
    assert any(row["expectedPassed"] is False and row["agrees"] is False for row in report["results"])


def test_claim_pilot_uses_only_the_frozen_pair_and_retains_claim_evidence(monkeypatch, tmp_path):
    calls = []

    def judge(question, answer, expected):
        calls.append((question, answer, expected))
        return {"score": 1, "passed": True, "reason": "Always accepts",
                "reference": expected, "claims": [answer], "verdicts": [{"verdict": "yes"}]}

    monkeypatch.setattr(evaluation, "judge_claims", judge)
    monkeypatch.setattr(evaluation, "judge_answer", lambda *args: pytest.fail("GEval must not run in the claim pilot"))
    code, report, _ = run_report(monkeypatch, tmp_path, {"mode": "claims-pilot"})
    assert code == 1
    assert report["policy"]["metric"] == "FaithfulnessClaimPipeline"
    assert report["policy"]["referenceMode"] == "verbatim"
    assert report["policy"]["claimVerification"] == "one-at-a-time"
    assert report["policy"]["penalizeAmbiguousClaims"] is True
    rows = report["results"]
    assert [row["id"] for row in rows] == ["valid-alternatives", "holdout-unavailable-alternative"]
    assert [row["expectedPassed"] for row in rows] == [True, False]
    fixture = json.loads((evaluation.ROOT / "tests/fixtures/judge/case-pack.json").read_text())
    for args, row in zip(calls, rows, strict=True):
        assert args == (fixture["question"], row["answer"], fixture["references"][0])
        assert row["reference"] == fixture["references"][0]
        assert row["claims"] == [row["answer"]]
        assert row["verdicts"] == [{"verdict": "yes"}]


def test_direct_claim_pilot_preserves_controlled_pairs_and_requires_an_explicit_contradiction(monkeypatch, tmp_path):
    calls = []

    def judge(question, claim, expected):
        calls.append((question, claim, expected))
        return {"score": 0, "passed": False, "reason": "Uncertain",
                "reference": expected, "claims": [claim], "verdicts": [{"verdict": "idk"}]}

    monkeypatch.setattr(evaluation, "judge_direct_claim", judge)
    monkeypatch.setattr(evaluation, "judge_claims", lambda *args: pytest.fail("Extraction must not run"))
    monkeypatch.setattr(evaluation, "judge_answer", lambda *args: pytest.fail("GEval must not run"))
    code, report, _ = run_report(monkeypatch, tmp_path, {"mode": "direct-claim-pilot"})
    assert code == 1
    assert report["policy"]["metric"] == "FaithfulnessVerdictStage"
    assert len(report["directClaimFixtureSha256"]) == 64
    rows = report["results"]
    assert [row["id"] for row in rows] == ["available-312", "unavailable-320", "unnamed-stock-overclaim", "named-stock-overclaim"]
    assert [row["expectedPassed"] for row in rows] == [True, False, False, False]
    assert [row["expectedVerdict"] for row in rows] == ["yes", "no", "no", "no"]
    assert not any(row["agrees"] for row in rows)  # An idk is not proof of a contradiction.
    assert rows[0]["answer"].replace("312", "320") == rows[1]["answer"]
    assert rows[2]["answer"].replace("320 units", "320 Redline Power Cell R12 units") == rows[3]["answer"]
    fixture = json.loads((evaluation.ROOT / "tests/fixtures/judge/case-pack.json").read_text())
    for args, row in zip(calls, rows, strict=True):
        assert args == (fixture["question"], row["answer"], fixture["references"][0])
        assert row["reference"] == fixture["references"][0]
