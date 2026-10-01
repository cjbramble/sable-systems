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
            raise RuntimeError("API unavailable")
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


@pytest.mark.parametrize("suite,count", [("coverage", 24), ("benchmark", 8)])
def test_expanded_suites_withhold_labels_and_retain_review_status(monkeypatch, tmp_path, suite, count):
    if suite == 'benchmark':
        # Scripted routing needs a fictional current-adapter freeze in a temp
        # root; the historical production freeze must remain unchanged.
        import hashlib
        import shutil
        freeze_name = 'tests/fixtures/judge/benchmark-freeze.json'
        freeze = json.loads((evaluation.ROOT / freeze_name).read_text())
        temporary = tmp_path / 'scripted-root'
        for name in (*freeze['sha256'], freeze_name, 'tests/fixtures/judge/holdout.json'):
            path = temporary / name
            path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(evaluation.ROOT / name, path)
        freeze['sha256'] = {name: hashlib.sha256((temporary / name).read_bytes()).hexdigest()
                            for name in freeze['sha256']}
        (temporary / freeze_name).write_text(json.dumps(freeze))
        monkeypatch.setattr(evaluation, 'ROOT', temporary)
    calls = []
    def judge(*args):
        calls.append(args)
        return {"score": 1, "passed": True, "reason": "Offline scripted verdict"}
    monkeypatch.setattr(evaluation, "judge_answer", judge)
    code, report, _ = run_report(monkeypatch, tmp_path, {"mode": "validation", "suite": suite})
    assert code == 1
    assert len(calls) == len(report["results"]) == count
    path = evaluation.ROOT / "tests/fixtures/judge" / ("coverage.json" if suite == "coverage" else "benchmark-candidate.json")
    fixtures = json.loads(path.read_text())
    expected = [(row["question"], example["text"], row["reference"])
                for row in fixtures["scenarios"] for example in row["examples"]]
    assert calls == expected
    assert report["suiteStatus"] == fixtures["status"]
    assert len(report["suiteSha256"]) == 64
    assert sum(row["expectedPassed"] for row in report["results"]) == count // 2
    if suite == "benchmark":
        assert report["benchmarkFreeze"]["reviewStatus"] == "pending-independent-human-review"


def test_benchmark_rejects_fixture_drift_before_any_judgment(monkeypatch, tmp_path):
    original = evaluation.ROOT
    import shutil
    shutil.copytree(original / "tests/fixtures/judge", tmp_path / "tests/fixtures/judge")
    shutil.copytree(original / "tools/evaluation", tmp_path / "tools/evaluation", ignore=shutil.ignore_patterns(".venv", "__pycache__"))
    (tmp_path / "lib").mkdir()
    shutil.copyfile(original / "lib/openrouter-config.json", tmp_path / "lib/openrouter-config.json")
    candidate = tmp_path / "tests/fixtures/judge/benchmark-candidate.json"
    candidate.write_text(candidate.read_text() + "\n")
    monkeypatch.setattr(evaluation, "ROOT", tmp_path)
    monkeypatch.setattr(evaluation, "judge_answer", lambda *args: pytest.fail("No judgment on drift"))
    with pytest.raises(ValueError, match="freeze mismatch"):
        run_report(monkeypatch, tmp_path, {"mode": "validation", "suite": "benchmark"})


@pytest.mark.parametrize("payload", [
    {"mode": "validation", "suite": "unknown"},
    {"mode": "transcript", "suite": "coverage"},
    {"mode": "validation", "suite": "benchmark", "validationSet": "holdout"},
])
def test_invalid_suite_selection_fails_before_judgment(monkeypatch, tmp_path, payload):
    monkeypatch.setattr(evaluation, "judge_answer", lambda *args: pytest.fail("No judgment for invalid suite"))
    with pytest.raises(ValueError):
        run_report(monkeypatch, tmp_path, payload)


@pytest.mark.parametrize("suite", ["claims", "extraction"])
def test_claim_controls_require_explicit_verdicts_and_keep_review_anchors_private(monkeypatch, tmp_path, suite):
    calls = []
    def judge(*args):
        calls.append(args)
        return {"score": 0, "passed": False, "reason": "Uncertain",
                "claims": [args[1]], "verdicts": [{"verdict": "idk", "reason": "Uncertain"}]}
    monkeypatch.setattr(evaluation, "judge_direct_claim" if suite == "claims" else "judge_claims", judge)
    monkeypatch.setattr(evaluation, "judge_answer", lambda *args: pytest.fail("Not GEval"))
    code, report, _ = run_report(monkeypatch, tmp_path, {"mode": "validation", "suite": suite})
    assert code == 1
    assert len(report["results"]) == len(calls) == 14
    if suite == "claims":
        assert not any(row["agrees"] for row in report["results"])
    else:
        assert all(row["claimCoverageReviewRequired"] and row["expectedClaims"] for row in report["results"])
    incomplete = report["results"][-1]
    assert incomplete["expectedPassed"] is True
    assert incomplete["expectedTaskComplete"] is False
    fixture = json.loads((evaluation.ROOT / "tests/fixtures/judge/claim-controls.json").read_text())
    assert calls == [(scenario["question"], row["text"], scenario["reference"])
                     for scenario in fixture["scenarios"] for row in scenario["examples"]]


def test_summary_separates_false_acceptances_rejections_and_execution_errors(monkeypatch, tmp_path):
    responses = iter([True, True, False, False, None] + [True] * 19)
    def judge(*args):
        value = next(responses)
        if value is None:
            raise TimeoutError("Scripted transport failure")
        return {"passed": value, "score": int(value), "reason": "Scripted"}
    monkeypatch.setattr(evaluation, "judge_answer", judge)
    code, report, _ = run_report(monkeypatch, tmp_path, {"mode": "validation", "suite": "coverage"})
    assert code == 1
    assert report["coverage"]["expectedSamples"] == report["coverage"]["processedSamples"] == 24
    summary = report["summary"]["overall"]
    assert summary["falseAcceptances"] == 11
    assert summary["falseRejections"] == 1
    assert summary["executionErrors"] == 1
    assert report["executionSuccessful"] is False
    assert report["labelAgreementSuccessful"] is False
    assert report["factualSuccessful"] is None


@pytest.mark.parametrize("batches", [{}, {"unsupported": {"samples": []}}, {"case-pack": {"samples": []}}])
def test_empty_or_unsupported_transcripts_cannot_report_success(monkeypatch, tmp_path, batches):
    monkeypatch.setattr(evaluation, "judge_answer", lambda *args: pytest.fail("No calls for malformed coverage"))
    with pytest.raises(ValueError):
        run_report(monkeypatch, tmp_path, {"mode": "transcript", "batches": batches})
