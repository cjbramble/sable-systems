"""Integration checks using the pinned local sentence embedding model."""

import json

import pytest

from evaluate import MANIFEST_PATH, ROOT, evaluate


def test_identical_reference_receives_unit_similarity_as_advisory_evidence():
    manifest = json.loads(MANIFEST_PATH.read_text())
    fixture = json.loads(
        (ROOT / "tests/fixtures/semantic/case-pack.json").read_text()
    )
    answer = fixture["references"][0]

    report = evaluate({"samples": [{"sample": 1, "answer": answer}]}, manifest)

    assert report["policy"]["mode"] == "advisory"
    assert len(report["samples"]) == 1
    sample = report["samples"][0]
    assert sample["sample"] == 1
    assert sample["answer"] == answer
    # Allow floating-point rounding, not a semantic acceptance threshold.
    assert sample["referenceScores"][0] == pytest.approx(1.0, abs=1e-6)
    assert sample["score"] == pytest.approx(1.0, abs=1e-6)
