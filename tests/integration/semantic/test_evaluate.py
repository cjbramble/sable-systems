"""Integration checks using the pinned local sentence embedding model."""

import json

import pytest

from evaluate import MANIFEST_PATH, ROOT, evaluate


@pytest.fixture
def manifest():
    return json.loads(MANIFEST_PATH.read_text())


def test_identical_reference_receives_unit_similarity_as_advisory_evidence(manifest):
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


def test_long_response_includes_the_final_partial_chunk_in_its_embedding(manifest):
    # The pinned encoder accepts 256 tokens, including two special tokens.
    # These single-token words give two full chunks and a distinct half chunk.
    prefix = "inventory " * 508
    answer = prefix + "orchard " * 127

    report = evaluate(
        {"samples": [
            {"sample": 1, "answer": prefix},
            {"sample": 2, "answer": answer},
        ]},
        manifest,
    )

    short, long = report["samples"]
    assert (short["tokens"], short["chunks"]) == (508, 2)
    assert (long["tokens"], long["chunks"]) == (635, 3)
    assert long["answer"] == answer
    # The tail must change the actual embedding, not just the reported counts.
    # This is a numerical inequality, not a response-quality cutoff.
    assert report["pairwiseSimilarity"][0][1] != pytest.approx(1.0, abs=1e-6)


@pytest.mark.parametrize("answer", ["", " \t\r\n "], ids=["empty", "whitespace"])
def test_rejects_blank_answers(manifest, answer):
    with pytest.raises(ValueError, match="^Only nonempty model answers can be scored$"):
        evaluate({"samples": [{"sample": 1, "answer": answer}]}, manifest)


@pytest.mark.parametrize("scenario", ["case-pack", "comparison"])
def test_calibration_preserves_example_labels_and_splits(manifest, scenario):
    fixture = json.loads(
        (ROOT / f"tests/fixtures/semantic/{scenario}.json").read_text()
    )

    report = evaluate({"samples": []}, manifest, scenario)

    examples = report["calibration"]["examples"]
    assert len(examples) == len(fixture["examples"])
    for actual, expected in zip(examples, fixture["examples"], strict=True):
        assert actual["correct"] is expected["correct"]
        for field in ("id", "text", "kind", "split"):
            assert actual[field] == expected[field]
