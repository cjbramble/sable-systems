"""HTML, JUnit and JSON reports for the judge collection."""

import json
import os
import xml.etree.ElementTree as ET
from collections import Counter
from collections.abc import Iterable, Mapping
from html import escape
from pathlib import Path

from judge_types import (
    CaseResult,
    CheckResult,
    CollectionReport,
    CollectionSummary,
    JudgeCase,
    Status,
)

STATUSES: tuple[Status, ...] = ("passed", "failed", "error", "pending")


def case_checks(
    case: JudgeCase, results: Mapping[str, CaseResult]
) -> list[CheckResult]:
    result = results.get(case["id"])
    completed = {check["kind"]: check for check in result["checks"]} if result else {}
    return [
        completed.get(kind, {"kind": kind, "expected": expected, "status": "pending"})
        for kind, expected in case["checks"].items()
    ]


def case_status(checks: list[CheckResult]) -> Status:
    statuses = {check["status"] for check in checks}
    priority: tuple[Status, ...] = ("error", "failed", "pending", "passed")
    return next(status for status in priority if status in statuses)


def counts(statuses: Iterable[Status]) -> dict[Status, int]:
    counter = Counter(statuses)
    return {status: counter[status] for status in STATUSES}


def summarize(report: CollectionReport) -> CollectionSummary:
    results = {result["id"]: result for result in report["results"]}
    cases = report["cases"]
    checks = {case["id"]: case_checks(case, results) for case in cases}
    return {
        "cases": counts(case_status(checks[c["id"]]) for c in cases),
        "checks": counts(check["status"] for cs in checks.values() for check in cs),
        "byCategory": {
            category: counts(
                case_status(checks[c["id"]])
                for c in cases
                if category in c["categories"]
            )
            for category in sorted({tag for c in cases for tag in c["categories"]})
        },
    }


def render_html(report: CollectionReport) -> str:
    def pretty(value: object) -> str:
        return escape(json.dumps(value, indent=2, ensure_ascii=False))

    def table(title: str, rows: Iterable[tuple[str, dict[Status, int]]]) -> str:
        header = (
            "<tr><th>Group</th>"
            + "".join(f"<th>{s.title()}</th>" for s in STATUSES)
            + "</tr>"
        )
        body = "".join(
            "<tr><th>"
            + escape(name)
            + "</th>"
            + "".join(f"<td>{row[s]}</td>" for s in STATUSES)
            + "</tr>"
            for name, row in rows
        )
        return f"<h2>{title}</h2><table>{header}{body}</table>"

    summary = report["summary"]
    parts = [
        table("Results", [("Cases", summary["cases"]), ("Checks", summary["checks"])]),
        table("Categories", summary["byCategory"].items()),
        "<p>Categories overlap. Passed means the judge matched the expected result, including correct rejection of a defective answer.</p>",
    ]
    results = {result["id"]: result for result in report["results"]}
    for case in report["cases"]:
        checks = case_checks(case, results)
        status = case_status(checks)
        evidence = {
            "question": case["question"],
            "references": case["references"],
            "answer": case["answer"],
            "checks": checks,
        }
        parts.append(
            f'<details class="{status}"><summary>{escape(case["id"])} — {status}</summary><pre>{pretty(evidence)}</pre></details>'
        )
    parts.append(
        f"<details><summary>Run settings and request totals</summary><pre>{pretty({'metadata': report['metadata'], 'requests': report.get('requests')})}</pre></details>"
    )
    return (
        '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
        "<title>Judge evaluation report</title><style>body{font:16px system-ui;max-width:1100px;margin:2rem auto;padding:0 1rem;color:#202020}"
        "table{border-collapse:collapse;width:100%;margin:1rem 0}th,td{text-align:left;padding:.6rem;border-bottom:1px solid #ddd}"
        "details{padding:.7rem;border-left:5px solid #999;margin:.6rem 0;background:#f6f6f6}summary{cursor:pointer}"
        ".passed{border-color:#187a37}.failed,.error{border-color:#ba2525}.pending{border-color:#aa7500}"
        "pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px}</style><h1>Judge evaluation report</h1>"
        f"<p>{escape(report['startedAt'])} · {'Complete' if report.get('finishedAt') else 'In progress / interrupted'} · Advisory judge</p>"
        + "".join(parts)
        + "</html>\n"
    )


def render_junit(report: CollectionReport) -> str:
    summary = report["summary"]["checks"]
    root = ET.Element(
        "testsuites",
        tests=str(sum(summary.values())),
        failures=str(summary["failed"]),
        errors=str(summary["error"]),
        skipped=str(summary["pending"]),
    )
    results = {result["id"]: result for result in report["results"]}
    for kind in ("answer", "direct", "extraction"):
        entries = [
            (c, check)
            for c in report["cases"]
            for check in case_checks(c, results)
            if check["kind"] == kind
        ]
        if not entries:
            continue
        totals = counts(check["status"] for _, check in entries)
        suite = ET.SubElement(
            root,
            "testsuite",
            name=f"Judge: {kind}",
            tests=str(len(entries)),
            failures=str(totals["failed"]),
            errors=str(totals["error"]),
            skipped=str(totals["pending"]),
        )
        for case, check in entries:
            node = ET.SubElement(
                suite,
                "testcase",
                name=case["id"],
                classname=f"judge.{kind}",
                time=str(check.get("seconds", 0)),
            )
            if check["status"] in ("failed", "error", "pending"):
                tag = {"failed": "failure", "error": "error", "pending": "skipped"}[
                    check["status"]
                ]
                ET.SubElement(
                    node,
                    tag,
                    message=check.get("error")
                    or (
                        "Not completed"
                        if tag == "skipped"
                        else "Judge disagreed with expected result"
                    ),
                ).text = json.dumps(check, indent=2)
            ET.SubElement(node, "system-out").text = json.dumps(
                {
                    "question": case["question"],
                    "references": case["references"],
                    "answer": case["answer"],
                    "check": check,
                },
                indent=2,
            )
    ET.indent(root)
    return ET.tostring(root, encoding="unicode", xml_declaration=True) + "\n"


def write_reports(destination: Path, report: CollectionReport) -> None:
    report["summary"] = summarize(report)
    report["successful"] = report["summary"]["cases"]["passed"] == len(report["cases"])
    for suffix, content in (
        (".json", json.dumps(report, indent=2) + "\n"),
        (".html", render_html(report)),
        (".xml", render_junit(report)),
    ):
        path = destination.with_suffix(suffix)
        temporary = path.with_suffix(path.suffix + ".tmp")
        temporary.write_text(content)
        os.replace(temporary, path)
