"""JUnit stays parseable without changing the original report evidence."""

import json
import xml.etree.ElementTree as ET

import pytest

import judge_collection as collection
import judge_report as reporting


@pytest.mark.parametrize(
    "raw, rendered",
    [
        ("A & <B>", "A & <B>"),
        ("tab\tline\nreturn\r", "tab\tline\nreturn\r"),
        ("café 😀", "café 😀"),
        ("NUL\x00", r"NUL\u0000"),
        ("ANSI\x1b[31m", r"ANSI\u001b[31m"),
        ("vertical\x0b", r"vertical\u000b"),
        ("surrogate\ud800", r"surrogate\ud800"),
        ("noncharacter\ufffe", r"noncharacter\ufffe"),
    ],
)
def test_junit_escapes_forbidden_characters_in_dynamic_attributes(raw, rendered):
    case = collection.load_cases()[0]
    case["id"] = f"case-{raw}"
    report = reporting.new_report([case], {})
    report["results"] = [
        {
            "id": case["id"],
            "seconds": 0,
            "checks": [
                {
                    "kind": "answer",
                    "expected": case["checks"]["answer"],
                    "status": "error",
                    "error": raw,
                }
            ],
        }
    ]
    report["summary"] = reporting.summarize(report)
    original = json.dumps(report)
    root = ET.fromstring(reporting.render_junit(report))
    assert root.find(".//testcase").get("name") == f"case-{rendered}"
    assert root.find(".//error").get("message") == rendered
    assert root.get("errors") == "1"
    assert json.dumps(report) == original
    assert json.loads(original)["results"][0]["checks"][0]["error"] == raw
