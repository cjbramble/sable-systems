"""Input boundaries and execution errors retain their meaning across modules."""

import json

import pytest

import judge_collection as collection
import support_grading as grading


@pytest.mark.parametrize(
    "method", ["judge_answer", "judge_direct_claim", "judge_claims"]
)
def test_judge_error_preserves_cause_and_snapshots_calls(monkeypatch, method):
    from judge_errors import JudgeError

    cause = TimeoutError("Provider timed out")
    calls = [{"attempt": 1, "httpStatus": 200, "errorType": "TimeoutError"}]

    class Judge:
        def __init__(self):
            self.requests = calls

        def generate(self, *args, **kwargs):
            raise cause

    monkeypatch.setattr(grading, "OpenRouterJudge", Judge)
    with pytest.raises(JudgeError) as caught:
        getattr(grading, method)("Question", "Answer", "Reference")
    error = caught.value
    assert error.__cause__ is cause
    assert error.cause is cause
    assert str(error) == "TimeoutError: Provider timed out"
    assert error.calls == calls
    assert not hasattr(cause, "judge_calls")
    calls.clear()
    assert len(error.calls) == 1


def test_collection_serializes_original_error_classification(monkeypatch):
    from judge_errors import JudgeError

    case = collection.load_cases()[0]
    calls = [{"httpStatus": 429, "attempt": 1}]

    def judge(*args):
        cause = RuntimeError("Judge HTTP failure: 429")
        raise JudgeError(cause, calls) from cause

    monkeypatch.setattr(collection, "judge_answer", judge)
    check = collection.evaluate_case(case)["checks"][0]
    assert check["status"] == "error"
    assert check["error"] == "RuntimeError: Judge HTTP failure: 429"
    assert check["actual"]["calls"] == calls


@pytest.mark.parametrize("schema_version", [True, 1.0, "1"])
def test_collection_schema_version_is_a_strict_integer(tmp_path, schema_version):
    path = tmp_path / "cases.json"
    path.write_text(
        json.dumps(
            {"schemaVersion": schema_version, "cases": collection.load_cases()[:1]}
        )
    )
    with pytest.raises(ValueError, match="schemaVersion"):
        collection.load_cases(path=path)


@pytest.mark.parametrize(
    "dimensions", [[], ["factualSupport", "taskCompleteness", "answerQuality"], "bad"]
)
def test_malformed_collection_dimensions_report_validation_error(tmp_path, dimensions):
    cases = collection.load_cases()[:1]
    cases[0]["checks"]["answer"]["dimensions"] = dimensions
    path = tmp_path / "cases.json"
    path.write_text(json.dumps({"schemaVersion": 1, "cases": cases}))
    with pytest.raises(ValueError, match="dimensions"):
        collection.load_cases(path=path)


def test_sample_models_preserve_whitespace_and_extra_failure_evidence():
    from judge_inputs import TranscriptSample

    data = {
        "sample": 1,
        "answer": "  raw response\n",
        "passed": False,
        "failure": {
            "sample": 1,
            "phase": "response-format",
            "error": "  Invalid response  ",
            "raw": {"content": [1, None]},
        },
    }
    sample = TranscriptSample.model_validate(data)
    assert sample.model_dump(exclude_unset=True) == data


def test_sample_models_do_not_coerce_failure_text():
    from judge_inputs import TranscriptSample

    with pytest.raises(ValueError, match="error"):
        TranscriptSample.model_validate(
            {
                "sample": 1,
                "answer": None,
                "passed": False,
                "failure": {"phase": "inference", "error": 42},
            }
        )


@pytest.mark.parametrize("field", ["dimensions", "verdict", "claims"])
def test_expected_check_rejects_explicit_null(tmp_path, field):
    cases = collection.load_cases()[:1]
    cases[0]["checks"]["answer"][field] = None
    path = tmp_path / "cases.json"
    path.write_text(json.dumps({"schemaVersion": 1, "cases": cases}))
    with pytest.raises(ValueError, match=f"{field} cannot be null"):
        collection.load_cases(path=path)
