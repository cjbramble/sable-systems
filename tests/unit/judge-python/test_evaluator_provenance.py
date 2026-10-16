"""Both report modes identify their dependency environment and source inputs."""

import hashlib
import importlib.metadata
import json
import subprocess
import sys

import judge_collection as collection
import transcript_evaluation as evaluation
from judge_inputs import TranscriptInput
from judge_settings import ROOT


def test_provenance_does_not_import_evaluator_sdks():
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            "from evaluator_provenance import evaluator_provenance; "
            "import sys; "
            "evidence = evaluator_provenance('judge_types.py'); "
            "assert evidence.dependency_versions['deepeval']; "
            "assert 'deepeval' not in sys.modules; "
            "assert 'pydantic' not in sys.modules",
        ],
        cwd=ROOT / "tools/evaluation",
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr


def test_both_report_modes_share_dependency_provenance(monkeypatch, tmp_path):
    case = collection.load_cases()[0]
    monkeypatch.setattr(collection, "load_cases", lambda categories: [case])
    monkeypatch.setattr(collection, "judge_metadata", lambda: ({}, {}))
    monkeypatch.setattr(evaluation, "judge_metadata", lambda: ({}, {}))
    monkeypatch.setattr(
        collection,
        "judge_answer",
        lambda *args: {**case["checks"]["answer"], "calls": []},
    )
    path = tmp_path / "collection.json"
    assert collection.run_collection({"concurrency": 1}, path) == 0
    metadata = json.loads(path.read_text())["metadata"]
    transcript = TranscriptInput.model_validate(
        {
            "mode": "transcript",
            "batches": {
                "case-pack": {
                    "request": {"source": "captured"},
                    "samples": [{"sample": 1, "answer": "Answer", "passed": True}],
                }
            },
        }
    )
    report = evaluation.new_report(transcript, evaluation.plan_transcript(transcript))
    expected_versions = {
        name: importlib.metadata.version(name)
        for name in ("deepeval", "pydantic", "typesafe-sdk", "httpx2")
    }
    assert (
        metadata["dependencyVersions"]
        == report["dependencyVersions"]
        == expected_versions
    )
    assert (
        metadata["deepevalVersion"]
        == report["deepevalVersion"]
        == expected_versions["deepeval"]
    )
    for name in ("uv.lock", "evaluator_provenance.py", "judge_types.py"):
        expected_hash = hashlib.sha256(
            (ROOT / "tools/evaluation" / name).read_bytes()
        ).hexdigest()
        assert (
            metadata["sourceSha256"][name]
            == report["evaluatorSha256"][name]
            == expected_hash
        )
    assert (
        metadata["sourceSha256"]["openrouter-config.json"]
        == report["evaluatorSha256"]["openrouter-config.json"]
    )
    assert (
        metadata["collectionSha256"]
        == hashlib.sha256(collection.COLLECTION.read_bytes()).hexdigest()
    )
    assert report["schemaVersion"] == 5
