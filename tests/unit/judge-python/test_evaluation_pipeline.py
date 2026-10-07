"""Execution stays reusable while reports retain ordered and partial evidence."""

import json
from threading import Event

import pytest

from judge_inputs import TranscriptInput


def transcript(*, concurrency=1):
    return TranscriptInput.model_validate(
        {
            "mode": "transcript",
            "concurrency": concurrency,
            "batches": {
                "case-pack": {
                    "request": {"source": "captured"},
                    "samples": [
                        {"sample": 1, "answer": "First answer", "passed": True},
                        {"sample": 2, "answer": "Second answer", "passed": True},
                    ],
                }
            },
        }
    )


def test_parallel_execution_emits_completion_order_and_returns_planned_order(
    monkeypatch,
):
    import transcript_evaluation as evaluation

    second_recorded = Event()
    recorded = []

    def judge(question, answer, reference):
        if answer == "First answer":
            assert second_recorded.wait(5), (
                "Second result must be recorded before first completes"
            )
        return {"passed": True, "calls": []}

    def record(result):
        recorded.append(result)
        if result["id"] == 2:
            second_recorded.set()

    monkeypatch.setattr(evaluation, "judge_answer", judge)
    planned = evaluation.plan_transcript(transcript(concurrency=2))
    results = evaluation.execute_transcript(planned, concurrency=2, on_result=record)
    assert [row["id"] for row in recorded] == [2, 1]
    assert [row["id"] for row in results] == [1, 2]
    assert all(row["sourceRequest"] == {"source": "captured"} for row in results)
    assert all(row["judgeApplicationAgrees"] for row in results)


def test_transcript_interruption_preserves_completed_evidence(monkeypatch, tmp_path):
    import transcript_evaluation as evaluation

    def judge(question, answer, reference):
        if answer == "Second answer":
            raise KeyboardInterrupt()
        return {"passed": True, "calls": [{"httpStatus": 200, "attempt": 1}]}

    monkeypatch.setattr(evaluation, "judge_answer", judge)
    monkeypatch.setattr(evaluation, "judge_metadata", lambda: ({}, {}))
    # Consume futures in submission order to isolate interruption persistence.
    monkeypatch.setattr(evaluation, "as_completed", iter)
    output = tmp_path / "interrupted.json"
    with pytest.raises(KeyboardInterrupt):
        evaluation.run_transcript(transcript(), output)
    assert not output.exists()
    evidence = [
        json.loads(line)
        for line in output.with_suffix(".jsonl").read_text().splitlines()
    ]
    assert evidence[0]["run"]["coverage"]["expectedSamples"] == 2
    assert evidence[1]["id"] == 1
    assert evidence[1]["calls"] == [{"httpStatus": 200, "attempt": 1}]
    assert len(evidence) == 2


def test_collection_reporter_checkpoints_before_case_completion(tmp_path):
    import judge_collection as collection
    import judge_report as reporting

    case = next(case for case in collection.load_cases() if len(case["checks"]) == 2)
    report = reporting.new_report([case], {})
    output = tmp_path / "report.json"
    kind, expected = next(iter(case["checks"].items()))
    check = {
        "kind": kind,
        "expected": expected,
        "status": "passed",
        "seconds": 0.25,
        "actual": {"calls": [{"attempt": 1, "httpStatus": 200}]},
    }
    with output.with_suffix(".jsonl").open("x") as evidence:
        writer = reporting.CollectionReporter(output, report, evidence)
        writer.start()
        writer.on_check(case["id"], check)
        saved = json.loads(output.read_text())
        assert saved["summary"]["checks"] == {
            "passed": 1,
            "failed": 0,
            "error": 0,
            "pending": 1,
        }
        assert saved["requests"]["requestAttempts"] == 1
        assert saved["results"][0]["seconds"] == 0.25
        assert "finishedAt" not in saved
        records = [
            json.loads(line)
            for line in output.with_suffix(".jsonl").read_text().splitlines()
        ]
        assert records[-1] == {"id": case["id"], "check": check}
