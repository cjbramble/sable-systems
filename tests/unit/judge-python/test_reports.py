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
