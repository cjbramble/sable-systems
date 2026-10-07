import json
import xml.etree.ElementTree as ET

import pytest

import judge_collection as collection


def test_collection_has_unique_inputs_and_expected_check_coverage():
    cases = collection.load_cases()
    assert len(cases) == 132
    assert sum(len(case["checks"]) for case in cases) == 148
    assert (
        len(
            {
                (case["question"], tuple(case["references"]), case["answer"])
                for case in cases
            }
        )
        == 132
    )
    assert sum("answer" in case["checks"] for case in cases) == 106
    assert sum("direct" in case["checks"] for case in cases) == 16
    assert sum("extraction" in case["checks"] for case in cases) == 26


def test_category_filter_rejects_unknown_categories():
    cases = collection.load_cases(["claims"])
    assert len(cases) == 16
    assert all("direct" in case["checks"] for case in cases)
    with pytest.raises(ValueError, match="Unknown category"):
        collection.load_cases(["typo"])
    combined = collection.load_cases(["claims", "extraction"])
    assert len(combined) == 26
    assert sum(len(case["checks"]) for case in combined) == 42


@pytest.mark.parametrize("mutation", ["duplicate", "empty", "unknown-check"])
def test_collection_rejects_invalid_cases(tmp_path, mutation):
    cases = collection.load_cases()[:1]
    if mutation == "duplicate":
        cases.append(cases[0])
    elif mutation == "empty":
        cases[0]["answer"] = ""
    else:
        cases[0]["checks"]["bogus"] = {"passed": True}
    path = tmp_path / "cases.json"
    path.write_text(json.dumps({"schemaVersion": 1, "cases": cases}))
    with pytest.raises(ValueError):
        collection.load_cases(path=path)


def test_check_errors_do_not_stop_other_checks_and_labels_are_withheld(monkeypatch):
    case = next(c for c in collection.load_cases() if len(c["checks"]) == 2)
    calls = []

    def direct(*args):
        calls.append(args)
        raise RuntimeError("upstream failure")

    def extract(*args):
        calls.append(args)
        return {
            "passed": case["checks"]["extraction"]["passed"],
            "claims": case["checks"]["extraction"]["claims"],
            "calls": [],
        }

    monkeypatch.setattr(collection, "judge_direct_claim", direct)
    monkeypatch.setattr(collection, "judge_claims", extract)
    result = collection.evaluate_case(case)
    assert [r["status"] for r in result["checks"]] == ["error", "passed"]
    assert calls == [(case["question"], case["answer"], case["references"][0])] * 2


def test_correct_rejection_passes_but_dimension_disagreement_fails(monkeypatch):
    case = next(
        c
        for c in collection.load_cases()
        if c["checks"].get("answer", {}).get("dimensions", {}).get("factualSupport")
        is False
    )
    expected = case["checks"]["answer"]
    monkeypatch.setattr(
        collection,
        "judge_answer",
        lambda *a: {"passed": False, "dimensions": expected["dimensions"]},
    )
    assert collection.evaluate_case(case)["checks"][0]["status"] == "passed"
    dims = {
        **expected["dimensions"],
        "answerQuality": not expected["dimensions"]["answerQuality"],
    }
    monkeypatch.setattr(
        collection, "judge_answer", lambda *a: {"passed": False, "dimensions": dims}
    )
    assert collection.evaluate_case(case)["checks"][0]["status"] == "failed"


def test_reports_distinguish_failures_errors_and_pending_and_escape_html(tmp_path):
    cases = collection.load_cases()[:4]
    report = collection.new_report(cases, {})
    for case, status in zip(cases[:3], ["passed", "failed", "error"]):
        report["results"].append(
            {
                "id": case["id"],
                "checks": [
                    {
                        "kind": "answer",
                        "status": status,
                        "expected": case["checks"]["answer"],
                        "actual": {"reason": "<script>alert(1)</script>"},
                        "error": "provider unavailable" if status == "error" else None,
                    }
                ],
                "seconds": 1,
            }
        )
    collection.write_reports(tmp_path / "report.json", report)
    data = json.loads((tmp_path / "report.json").read_text())
    assert data["summary"]["cases"] == {
        "passed": 1,
        "failed": 1,
        "error": 1,
        "pending": 1,
    }
    xml = ET.parse(tmp_path / "report.xml").getroot()
    assert {k: xml.get(k) for k in ("tests", "failures", "errors", "skipped")} == {
        "tests": "4",
        "failures": "1",
        "errors": "1",
        "skipped": "1",
    }
    html = (tmp_path / "report.html").read_text()
    assert "<script>alert(1)</script>" not in html
    assert "&lt;script&gt;" in html
    assert "provider unavailable" in html
    assert "pending" in html


def test_run_writes_reports_continues_after_errors_and_exits_red(monkeypatch, tmp_path):
    cases = collection.load_cases()[:3]
    monkeypatch.setattr(collection, "load_cases", lambda categories: cases)
    monkeypatch.setattr(collection, "judge_metadata", lambda: ({"alias": "test"}, {}))

    def judge(question, answer, reference):
        index = [case["answer"] for case in cases].index(answer)
        if index == 2:
            raise RuntimeError("provider unavailable")
        return {
            "passed": cases[index]["checks"]["answer"]["passed"]
            if index == 0
            else not cases[index]["checks"]["answer"]["passed"],
            "calls": [],
        }

    monkeypatch.setattr(collection, "judge_answer", judge)
    path = tmp_path / "run.json"
    assert collection.run_collection({"concurrency": 2}, path) == 1
    report = json.loads(path.read_text())
    assert report["summary"]["cases"] == {
        "passed": 1,
        "failed": 1,
        "error": 1,
        "pending": 0,
    }
    assert report["finishedAt"]
    assert len(path.with_suffix(".jsonl").read_text().splitlines()) == 7
    xml = ET.parse(path.with_suffix(".xml")).getroot()
    assert xml.get("failures") == "1"
    assert xml.get("errors") == "1"
    assert report["requests"]["requestAttempts"] == 0
    original = path.read_bytes()
    with pytest.raises(ValueError, match="already exists"):
        collection.run_collection({"concurrency": 2}, path)
    assert path.read_bytes() == original


def test_list_does_not_require_credentials_or_write_reports(
    monkeypatch, tmp_path, capsys
):
    monkeypatch.setattr(
        collection,
        "judge_metadata",
        lambda: pytest.fail("Listing must not inspect live configuration"),
    )
    assert collection.run_collection({"list": True}, tmp_path / "unused.json") == 0
    assert "132 cases; 148 checks" in capsys.readouterr().out
    assert not list(tmp_path.iterdir())


def test_interruption_preserves_completed_check_and_leaves_rest_pending(
    monkeypatch, tmp_path
):
    case = next(c for c in collection.load_cases() if len(c["checks"]) == 2)
    monkeypatch.setattr(collection, "load_cases", lambda categories: [case])
    monkeypatch.setattr(collection, "judge_metadata", lambda: ({}, {}))
    monkeypatch.setattr(
        collection,
        "judge_direct_claim",
        lambda *a: {
            "passed": case["checks"]["direct"]["passed"],
            "verdicts": [{"verdict": case["checks"]["direct"]["verdict"]}],
            "calls": [{"httpStatus": 200, "attempt": 1}],
        },
    )

    def interrupted(*args):
        raise KeyboardInterrupt()

    monkeypatch.setattr(collection, "judge_claims", interrupted)
    path = tmp_path / "interrupted.json"
    with pytest.raises(KeyboardInterrupt):
        collection.run_collection({}, path)
    report = json.loads(path.read_text())
    assert report["summary"]["checks"] == {
        "passed": 1,
        "failed": 0,
        "error": 0,
        "pending": 1,
    }
    assert report["summary"]["cases"]["pending"] == 1
    assert report["requests"]["requestAttempts"] == 1
    assert not report["successful"]
    assert not report.get("finishedAt")
    xml = ET.parse(path.with_suffix(".xml")).getroot()
    assert xml.get("tests") == "2"
    assert xml.get("skipped") == "1"


@pytest.mark.parametrize("concurrency", [0, 5, True, "2"])
def test_invalid_concurrency_fails_before_configuration_or_calls(
    monkeypatch, tmp_path, concurrency
):
    monkeypatch.setattr(
        collection, "judge_metadata", lambda: pytest.fail("No model configuration")
    )
    with pytest.raises(ValueError, match="concurrency"):
        collection.run_collection(
            {"concurrency": concurrency}, tmp_path / "unused.json"
        )
    assert not list(tmp_path.iterdir())


def test_parallel_execution_preserves_final_case_order(monkeypatch, tmp_path):
    from threading import Event

    second_started = Event()
    cases = collection.load_cases()[:2]
    monkeypatch.setattr(collection, "load_cases", lambda categories: cases)
    monkeypatch.setattr(collection, "judge_metadata", lambda: ({}, {}))

    def judge(question, answer, reference):
        if answer == cases[0]["answer"]:
            assert second_started.wait(2), (
                "Second case must run while the first is waiting"
            )
        else:
            second_started.set()
        expected = next(
            case["checks"]["answer"] for case in cases if case["answer"] == answer
        )
        return {**expected, "calls": []}

    monkeypatch.setattr(collection, "judge_answer", judge)
    output = tmp_path / "parallel.json"
    assert collection.run_collection({"concurrency": 2}, output) == 0
    assert [row["id"] for row in json.loads(output.read_text())["results"]] == [
        case["id"] for case in cases
    ]
