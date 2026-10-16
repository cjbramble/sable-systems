import judge_collection as collection


def test_false_routes_do_not_get_relabelled_as_missing():
    rows = {
        case["id"].split("/")[-1]: case["checks"]["answer"]["dimensions"]
        for case in collection.load_cases()
        if "/action-refusal/" in case["id"]
    }
    assert rows["incorrect"] == {
        "factualSupport": False,
        "taskCompleteness": True,
        "answerQuality": False,
    }
    assert rows["partial-refusal"] == {
        "factualSupport": True,
        "taskCompleteness": False,
        "answerQuality": True,
    }
    assert rows["approval-route-only"] == {
        "factualSupport": False,
        "taskCompleteness": False,
        "answerQuality": False,
    }


def test_direct_controls_preserve_unsupported_and_contradicted_date_labels(monkeypatch):
    cases = collection.load_cases(["claims"])
    for original in cases:
        case = {**original, "checks": {"direct": original["checks"]["direct"]}}
        expected = case["checks"]["direct"]
        monkeypatch.setattr(
            collection,
            "judge_direct_claim",
            lambda *args: {
                "passed": expected["passed"],
                "verdicts": [{"verdict": expected["verdict"]}],
                "calls": [],
            },
        )
        assert (
            next(
                check
                for check in collection.evaluate_case(case)["checks"]
                if check["kind"] == "direct"
            )["status"]
            == "passed"
        )
    assert sum(c["checks"]["direct"]["verdict"] == "idk" for c in cases) == 1
    assert (
        next(c for c in cases if c["id"] == "claims/unsupported-date/unsupported")[
            "checks"
        ]["direct"]["verdict"]
        == "idk"
    )
    assert (
        next(c for c in cases if c["id"] == "claims/recorded-date/contradicted")[
            "checks"
        ]["direct"]["verdict"]
        == "no"
    )
