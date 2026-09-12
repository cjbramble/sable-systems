"""Integration checks using the pinned local sentence embedding model."""

import json

import pytest

import evaluate as semantic_evaluator
from evaluate import MANIFEST_PATH, ROOT, evaluate


@pytest.fixture
def manifest():
    return json.loads(MANIFEST_PATH.read_text())


@pytest.fixture
def case_pack_fixture():
    return json.loads(
        (ROOT / "tests/fixtures/semantic/case-pack.json").read_text()
    )


def test_identical_reference_receives_unit_similarity_as_advisory_evidence(
    manifest, case_pack_fixture
):
    answer = case_pack_fixture["references"][0]

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


def test_calibration_statistics_exclude_holdout_examples(
    manifest, case_pack_fixture, tmp_path, monkeypatch
):
    reference = case_pack_fixture["references"][0]
    unrelated = "The orchard is blooming and the birds are singing."
    # Synthetic labels deliberately invert holdout scores to expose leakage.
    # They are test controls, not changes to the real calibration dataset.
    case_pack_fixture["examples"] = [
        {"id": "calibration-correct", "split": "calibration", "correct": True, "text": reference},
        {"id": "calibration-incorrect", "split": "calibration", "correct": False, "text": unrelated},
        {"id": "holdout-correct", "split": "holdout", "correct": True, "text": unrelated},
        {"id": "holdout-incorrect", "split": "holdout", "correct": False, "text": reference},
    ]
    fixture_path = tmp_path / "tests/fixtures/semantic/case-pack.json"
    fixture_path.parent.mkdir(parents=True)
    fixture_path.write_text(json.dumps(case_pack_fixture))
    local_manifest = {**manifest, "directory": str(ROOT / manifest["directory"])}
    monkeypatch.setattr(semantic_evaluator, "ROOT", tmp_path)

    report = evaluate({"samples": []}, local_manifest)

    calibration = report["calibration"]
    scores = {row["id"]: row["score"] for row in calibration["examples"]}
    minimum_correct = scores["calibration-correct"]
    maximum_incorrect = scores["calibration-incorrect"]
    assert scores["holdout-correct"] < minimum_correct
    assert scores["holdout-incorrect"] > maximum_incorrect
    assert calibration["minimumCorrectScore"] == minimum_correct
    assert calibration["maximumIncorrectScore"] == maximum_incorrect
    assert calibration["candidateThreshold"] == pytest.approx(
        (minimum_correct + maximum_incorrect) / 2
    )
    assert calibration["holdoutErrors"] == ["holdout-correct", "holdout-incorrect"]
    assert calibration["status"] == "candidate_requires_review"
    assert report["policy"]["mode"] == "advisory"
