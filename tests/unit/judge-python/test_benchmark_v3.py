"""Fresh revision-13 benchmark contracts, with no live model calls."""

import io
import json
import shutil
import sys

import pytest

import benchmark_review as gate
import evaluate_support as evaluation
from openrouter_judge import judge_metadata, RETRY_POLICY


@pytest.fixture(autouse=True)
def frozen_judge_settings(monkeypatch):
    # The cloud environment may carry an explicit older output allowance.
    monkeypatch.setenv("OPENROUTER_JUDGE_MAX_TOKENS", "16384")
    monkeypatch.setenv("OPENROUTER_JUDGE_REASONING", "true")
    monkeypatch.setenv("OPENROUTER_JUDGE_MODEL", "z-ai/glm-5.3-flash")


def test_v3_is_balanced_novel_and_frozen_with_bounded_attempt_budget():
    root = evaluation.ROOT
    fixture_path = root / "tests/fixtures/judge/qualification-v3.json"
    assert fixture_path.exists(), "Fresh revision-13 fixture must be prepared"
    fixture = json.loads(fixture_path.read_text())
    rows = [row for scenario in fixture["scenarios"] for row in scenario["examples"]]
    assert len(fixture["scenarios"]) == 20
    assert len(rows) == 40
    assert sum(row["correct"] for row in rows) == 20
    assert all(row["correct"] == all(row["expectedDimensions"].values()) for row in rows)
    exposed = set()
    for path in (root / "tests/fixtures/judge").glob("*.json"):
        if path == fixture_path:
            continue
        old = json.loads(path.read_text())
        scenarios = old.get("scenarios", [])
        if isinstance(scenarios, list):
            exposed.update(row["text"] for scenario in scenarios for row in scenario.get("examples", []) if "text" in row)
    assert not exposed.intersection(row["text"] for row in rows)
    freeze = json.loads((root / gate.V3_FREEZE).read_text())
    assert freeze["gradingRevision"] == fixture["gradingRevision"] == 13
    assert freeze["retryPolicy"] == RETRY_POLICY
    assert freeze["qualificationPolicy"]["maxLogicalRequestsPerRun"] == 40
    assert freeze["qualificationPolicy"]["maxModelCallsPerRun"] == 160
    assert freeze["generation"]["max_tokens"] == 16384
    # Historical reviewed source is preserved while the current reporting runner evolves.
    assert gate.digest(root / gate.V3_FIXTURE) == freeze["sha256"][gate.V3_FIXTURE]
    assert gate.digest(root / gate.V3_SHEET) == freeze["sha256"][gate.V3_SHEET]
    review = json.loads((root / gate.V3_REVIEW).read_text())
    assert review["decision"] in ("pending", "approved")
    if review["decision"] == "approved":
        assert review["independentHumanReview"] is True
        assert review["reviewedBeforeLiveExposure"] is True
        assert review["reviewer"] and review["reviewedAt"]
    assert review["fixtureSha256"] == gate.digest(fixture_path)
    assert review["freezeSha256"] == gate.digest(root / gate.V3_FREEZE)


@pytest.fixture
def candidate_root(tmp_path):
    for name in (*gate.V3_LOCK_FILES, gate.V3_FREEZE, gate.V3_REVIEW, "tests/fixtures/judge/holdout.json"):
        path = tmp_path / name
        path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(evaluation.ROOT / name, path)
    # Fictional current-code freeze in the temporary root only. The actual
    # completed revision-13 freeze and approval remain unchanged.
    freeze_path = tmp_path / gate.V3_FREEZE
    freeze = json.loads(freeze_path.read_text())
    freeze["sha256"] = {name: gate.digest(tmp_path / name) for name in gate.V3_LOCK_FILES}
    freeze_path.write_text(json.dumps(freeze))
    # Exercise pending review independently of actual human approval.
    path = tmp_path / gate.V3_REVIEW
    review = json.loads(path.read_text())
    review.update(freezeSha256=gate.digest(freeze_path), decision="pending", reviewer=None, reviewedAt=None,
                  independentHumanReview=False, reviewedBeforeLiveExposure=False)
    path.write_text(json.dumps(review))
    return tmp_path


def approve(root):
    path = root / gate.V3_REVIEW
    review = json.loads(path.read_text())
    review.update(decision="approved", reviewer="Fictional offline reviewer",
                  reviewedAt="2026-10-01T00:00:00+00:00", independentHumanReview=True,
                  reviewedBeforeLiveExposure=True)
    path.write_text(json.dumps(review))


def run(monkeypatch, root, output):
    monkeypatch.setattr(evaluation, "ROOT", root)
    monkeypatch.setattr(sys, "argv", ["evaluate_support.py", "--output", str(output)])
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps({"mode": "validation", "suite": "qualification-v3", "concurrency": 2})))
    return evaluation.main()


def test_pending_v3_review_blocks_calls_and_artifacts(monkeypatch, candidate_root, tmp_path):
    monkeypatch.setattr(evaluation, "judge_answer", lambda *args: pytest.fail("No live calls"))
    output = tmp_path / "pending.json"
    with pytest.raises(ValueError, match="review docs/deepeval-benchmark-v3-review.md"):
        run(monkeypatch, candidate_root, output)
    assert not output.exists()
    assert not output.with_suffix(".jsonl").exists()


def test_v3_requires_two_workers(candidate_root):
    approve(candidate_root)
    with pytest.raises(ValueError, match="frozen concurrency of 2"):
        gate.validate_qualification(candidate_root, *judge_metadata(), 1, version=3)


@pytest.mark.parametrize("change", ["fixture", "code", "retryPolicy", "generation", "approval", "budget", "revision"])
def test_v3_rejects_stale_or_altered_approval(candidate_root, change):
    approve(candidate_root)
    if change in ("fixture", "code"):
        path = candidate_root / (gate.V3_FIXTURE if change == "fixture" else "tools/evaluation/openrouter_judge.py")
        path.write_text(path.read_text() + "\n")
    else:
        path = candidate_root / gate.V3_FREEZE
        freeze = json.loads(path.read_text())
        if change == "retryPolicy":
            freeze["retryPolicy"]["maxRetries"] = 4
        elif change == "generation":
            freeze["generation"]["max_tokens"] = 8192
        elif change == "budget":
            freeze["qualificationPolicy"]["maxModelCallsPerRun"] = 40
        elif change == "revision":
            freeze["gradingRevision"] = 12
        else:
            review_path = candidate_root / gate.V3_REVIEW
            review_path.write_bytes((evaluation.ROOT / gate.V2_REVIEW).read_bytes())
        path.write_text(json.dumps(freeze))
    with pytest.raises(ValueError):
        gate.validate_qualification(candidate_root, *judge_metadata(), 2, version=3)


def test_v3_approved_routing_withholds_labels_and_preserves_retry_evidence(monkeypatch, candidate_root, tmp_path):
    approve(candidate_root)
    fixture = json.loads((candidate_root / gate.V3_FIXTURE).read_text())
    expected = {(s["question"], r["text"], s["reference"]): r for s in fixture["scenarios"] for r in s["examples"]}
    seen = []

    def scripted(question, answer, reference):
        seen.append((question, answer, reference))
        row = expected[(question, answer, reference)]
        return {"passed": row["correct"], "dimensions": row["expectedDimensions"],
                "calls": [{"logicalRequest": 1, "attempt": 1, "httpStatus": 429},
                          {"logicalRequest": 1, "attempt": 2, "httpStatus": 200, "completed": True}]}

    monkeypatch.setattr(evaluation, "judge_answer", scripted)
    output = tmp_path / "scripted.json"
    assert run(monkeypatch, candidate_root, output) == 0
    report = json.loads(output.read_text())
    assert sorted(seen) == sorted(expected)
    assert report["suite"] == "qualification-v3"
    assert report["policy"]["gradingRevision"] == 13
    assert report["benchmarkFreeze"]["independentReview"]["reviewer"] == "Fictional offline reviewer"
    assert report["coverage"]["processedSamples"] == 40
    assert report["summary"]["overall"]["requestAttempts"] == 80
    assert report["summary"]["overall"]["recoveredRateLimitedRequests"] == 40
    assert report["executionSuccessful"] is True


def test_original_review_cannot_authorize_changed_reporting_code():
    with pytest.raises(ValueError, match="Qualification freeze mismatch"):
        gate.validate_qualification(evaluation.ROOT, *judge_metadata(), 2, version=3)
