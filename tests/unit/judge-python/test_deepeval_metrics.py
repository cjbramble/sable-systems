"""Exercise real DeepEval metrics and runner with a controlled model boundary."""

import pytest

import openrouter_judge
import support_grading as grading
from judge_errors import JudgeError


@pytest.fixture
def model(monkeypatch):
    state = {
        "truths": ["47 units available."],
        "claims": ["47 units."],
        "verdicts": [{"verdict": "yes", "reason": "Recorded stock."}],
        "scores": [1, 1, 1],
        "test_cases": [],
        "prompts": [],
        "schemas": [],
    }

    def request(body, schema, calls):
        state["prompts"].append(body["messages"][0]["content"])
        state["schemas"].append(schema.__name__)
        calls.append({"request": body, "completed": True})
        if schema.__name__ in ("Truths", "Claims", "Verdicts"):
            field = next(iter(schema.model_fields))
            data = {field: state[field]}
        elif "score" in schema.model_fields:
            data = {"score": state["scores"].pop(0), "reason": "Evaluated dimension."}
        else:
            data = {"reason": "Evaluated support."}
        return schema.model_validate(data)

    evaluate = grading.evaluate

    def track_evaluation(**kwargs):
        state["test_cases"].extend(kwargs["test_cases"])
        return evaluate(**kwargs)

    monkeypatch.setattr(grading, "evaluate", track_evaluation)
    monkeypatch.setattr(openrouter_judge, "request_verdict", request)
    return state


@pytest.mark.parametrize("verdict", ["no", "idk"])
def test_standalone_faithfulness_rejects_contradictions_and_unknowns(model, verdict):
    model["verdicts"][0]["verdict"] = "borderline" if verdict == "idk" else verdict
    result = grading.judge_claims("Stock?", "47 units.", "47 units available.")
    assert not result["passed"]
    assert result["verdicts"][0]["verdict"] == verdict
    assert set(model["schemas"]) >= {"Truths", "Claims", "Verdicts"}


def test_whole_answer_grounding_cannot_be_compensated_by_other_dimensions(model):
    model["scores"] = [0, 1, 1]
    result = grading.judge_answer("Stock?", "47 units.", "47 units available.")
    assert result["dimensions"] == {
        "factualSupport": False,
        "taskCompleteness": True,
        "answerQuality": True,
    }
    assert not result["passed"]
    assert len(result["metrics"]) == 3


@pytest.mark.parametrize(
    "scores, expected", [([1, 0, 1], "taskCompleteness"), ([1, 1, 0], "answerQuality")]
)
def test_independent_geval_failures_cannot_be_averaged_away(model, scores, expected):
    model["scores"] = scores
    result = grading.judge_answer("Stock?", "47 units.", "47 units available.")
    assert result["dimensions"][expected] is False
    assert result["dimensions"]["factualSupport"] is True
    assert not result["passed"]


def test_runner_preserves_metric_results_and_disables_cache(model):
    first = grading.judge_answer("Stock?", "47 units.", "47 units available.")
    count = len(model["schemas"])
    model["scores"] = [1, 1, 1]
    second = grading.judge_answer("Stock?", "47 units.", "47 units available.")
    assert first["passed"] and second["passed"]
    assert len(model["schemas"]) == count * 2
    assert all(metric["score"] == 1 for metric in first["metrics"])
    assert len(first["calls"]) == count


def test_incomplete_verdict_inventory_is_execution_error(model):
    model["verdicts"] = []
    with pytest.raises(JudgeError, match="verdict"):
        grading.judge_claims("Stock?", "47 units.", "47 units available.")


def test_empty_extraction_cannot_pass_claim_calibration(model):
    model["claims"] = []
    with pytest.raises(JudgeError, match="claims"):
        grading.judge_claims("Stock?", "47 units.", "47 units available.")


def test_direct_claim_reports_worst_verdict_for_compound_statement(model):
    model["claims"] = ["47 units.", "Delivery tomorrow."]
    model["verdicts"] = [
        {"verdict": "yes"},
        {"verdict": "borderline", "reason": "No date."},
    ]
    result = grading.judge_direct_claim(
        "Stock and date?", "47 units. Delivery tomorrow.", "47 units available."
    )
    assert not result["passed"]
    assert result["verdicts"][0]["verdict"] == "idk"


def test_conversation_context_is_separate_from_current_authoritative_evidence(model):
    history = [
        {"role": "user", "content": "What about Nova?"},
        {"role": "assistant", "content": "Yesterday: 100 units."},
    ]
    model["scores"] = [1, 1, 1, 0]
    result = grading.judge_answer(
        "How many now?",
        "47 units.",
        "47 units available.",
        history=history,
        policy="Only authorized records establish current stock.",
    )
    assert result["passed"]
    assert result["conversationMetrics"][0]["success"] is False
    test_case = model["test_cases"][0]
    assert all("100 units" not in context for context in test_case.retrieval_context)
    assert "47 units available." in test_case.retrieval_context
    assert "100 units" in test_case.context[0]
    conversation_prompt = model["prompts"][-1]
    assert "Yesterday: 100 units" in conversation_prompt
    assert "How many now?" in conversation_prompt
    assert "47 units available" in conversation_prompt


def test_async_model_adapter_uses_the_same_schema_transport(model):
    import asyncio

    from deepeval.metrics.faithfulness.schema import Claims

    judge = openrouter_judge.OpenRouterJudge()
    result = asyncio.run(judge.a_generate("Extract claims", Claims))
    assert result.claims == ["47 units."]
    assert judge.requests[0]["completed"]


def test_answer_grounding_does_not_depend_on_claim_extraction(model):
    model["claims"] = []
    model["scores"] = [0, 1, 1]
    result = grading.judge_answer("Stock?", "47 units.", "47 units available.")
    assert result["dimensions"]["factualSupport"] is False
    assert not result["passed"]
    assert "Claims" not in model["schemas"]


def test_whitespace_claim_is_execution_error(model):
    model["claims"] = [" "]
    with pytest.raises(JudgeError, match="nonempty extracted claims"):
        grading.judge_claims("Stock?", "47 units.", "47 units available.")


def test_conversation_rubric_uses_framework_ten_point_scale(model):
    model["scores"] = [1, 1, 1, 10]
    result = grading.judge_answer(
        "How many now?",
        "47 units.",
        "47 units available.",
        history=[{"role": "user", "content": "How many units?"}],
    )
    assert result["conversationMetrics"][0]["success"]
    assert result["conversationMetrics"][0]["score"] == 1
    assert "Score 1 if" not in model["prompts"][-1]


def test_whole_answer_grounding_receives_question_and_reference_only_history(model):
    result = grading.judge_answer(
        "How many Redline units?",
        "It has 47 units.",
        "Nova has 47; Redline has 100.",
    )
    assert "How many Redline units?" in model["prompts"][0]
    assert "Nova has 47; Redline has 100." in model["prompts"][0]
    assert "It has 47 units." in model["prompts"][0]
    assert result["metrics"][0]["name"] == "Factual support [GEval]"
