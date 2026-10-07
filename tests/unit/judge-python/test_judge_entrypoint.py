"""Only the current collection and captured transcripts may run."""

import io
import json
import sys

import pytest

import evaluate_support as evaluation
import transcript_evaluation
from openrouter_judge import ROOT


@pytest.mark.parametrize(
    "payload",
    [
        {"mode": "validation", "suite": "legacy"},
        {"mode": "validation", "suite": "benchmark"},
        {"mode": "validation", "suite": "qualification-v5"},
        {"mode": "claims-pilot"},
        {"mode": "direct-claim-pilot"},
        {"mode": "transcript", "suite": "qualification-v5"},
        {"mode": "collection", "suite": "coverage"},
    ],
)
def test_retired_modes_fail_before_requests_or_reports(monkeypatch, tmp_path, payload):
    monkeypatch.setattr(
        transcript_evaluation,
        "judge_metadata",
        lambda: pytest.fail("No model request for retired modes"),
    )
    path = tmp_path / "report.json"
    monkeypatch.setattr(sys, "argv", ["evaluate_support.py", "--output", str(path)])
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps(payload)))
    with pytest.raises(ValueError, match="mode|suite"):
        evaluation.main()
    assert not list(tmp_path.iterdir())


@pytest.mark.parametrize(
    "arguments,message",
    [
        (["--suite", "benchmark"], "Unknown option"),
        (["--holdout"], "Unknown option"),
        (["--claims-pilot"], "Unknown option"),
        (["--direct-claim-pilot"], "Unknown option"),
        (["--transcript", "unused.log", "--category", "claims"], "cannot be combined"),
        (["--transcript", "unused.log", "--list"], "cannot be combined"),
        (["--concurrency", "5"], "Choose --concurrency"),
    ],
)
def test_cli_rejects_retired_or_conflicting_flags(arguments, message):
    import subprocess

    result = subprocess.run(
        ["node", "scripts/test-support-judge.mjs", *arguments],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert result.returncode == 1
    assert message in result.stderr
    assert "Judging with" not in result.stdout
