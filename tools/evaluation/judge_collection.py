"""Run the current judge case collection independently of application tests."""

import hashlib
import json
import time
from collections.abc import Callable, Sequence
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import UTC, datetime
from pathlib import Path
from threading import Lock

from judge_errors import error_calls, error_message
from judge_inputs import CollectionInput, CollectionOptions
from judge_report import summarize, write_reports
from judge_types import (
    CaseResult,
    CheckResult,
    CollectionMetadata,
    CollectionReport,
    JudgeCase,
)
from openrouter_judge import RETRY_POLICY, ROOT, judge_metadata, summarize_requests
from support_grading import (
    GRADING_REVISION,
    assess_claim_coverage,
    judge_answer,
    judge_claims,
    judge_direct_claim,
)

COLLECTION = ROOT / "tests/fixtures/judge/judge-cases.json"


def load_cases(
    categories: Sequence[str] = (), *, path: Path = COLLECTION
) -> list[JudgeCase]:
    data = CollectionInput.model_validate_json(path.read_text())
    cases = [case.report_data() for case in data.cases]
    for case in cases:
        if "extraction" in case["checks"]:
            claims = case["checks"]["extraction"]["claims"]
            assess_claim_coverage(case["answer"], claims, claims)
    unknown = set(categories) - {tag for case in cases for tag in case["categories"]}
    if unknown:
        raise ValueError("Unknown category: " + ", ".join(sorted(unknown)))
    return [
        case
        for case in cases
        if not categories or set(categories).intersection(case["categories"])
    ]


def evaluate_case(
    case: JudgeCase,
    on_check: Callable[[str, CheckResult], None] | None = None,
) -> CaseResult:
    started = time.monotonic()
    results: list[CheckResult] = []
    for kind, expected in case["checks"].items():
        check: CheckResult = {"kind": kind, "expected": expected, "status": "pending"}
        check_started = time.monotonic()
        try:
            judge = {
                "answer": judge_answer,
                "direct": judge_direct_claim,
                "extraction": judge_claims,
            }[kind]
            actual = judge(case["question"], case["answer"], case["references"][0])
            agrees = actual["passed"] == expected["passed"]
            if "dimensions" in expected:
                agrees = agrees and all(
                    actual["dimensions"][key] == value
                    for key, value in expected["dimensions"].items()
                )
            if kind == "direct":
                agrees = (
                    agrees and actual["verdicts"][0]["verdict"] == expected["verdict"]
                )
            if kind == "extraction":
                actual["claimCoverage"] = assess_claim_coverage(
                    case["answer"], expected["claims"], actual["claims"]
                )
                agrees = agrees and actual["claimCoverage"]["passed"]
            check.update({"status": "passed" if agrees else "failed", "actual": actual})
        except Exception as error:
            check.update(
                {
                    "status": "error",
                    "error": error_message(error),
                    "actual": {"calls": error_calls(error)},
                }
            )
        check["seconds"] = round(time.monotonic() - check_started, 2)
        results.append(check)
        if on_check:
            on_check(case["id"], check)
    return {
        "id": case["id"],
        "checks": results,
        "seconds": round(time.monotonic() - started, 2),
    }


def new_report(
    cases: list[JudgeCase], metadata: CollectionMetadata
) -> CollectionReport:
    return {
        "schemaVersion": 1,
        "mode": "judge-collection",
        "policy": "advisory",
        "startedAt": datetime.now(UTC).isoformat(),
        "metadata": metadata,
        "cases": cases,
        "results": [],
    }


def run_collection(payload: object, destination: str | Path) -> int:
    options = CollectionOptions.model_validate(payload)
    categories = options.categories
    cases = load_cases(categories)
    if options.list_cases:
        print(f"{len(cases)} cases; {sum(len(c['checks']) for c in cases)} checks")
        for category in sorted({tag for case in cases for tag in case["categories"]}):
            print(
                f"  {category}: {sum(category in c['categories'] for c in cases)} cases"
            )
        return 0
    concurrency = options.concurrency
    model, generation = judge_metadata()
    metadata: CollectionMetadata = {
        "model": model,
        "generation": generation,
        "gradingRevision": GRADING_REVISION,
        "retryPolicy": RETRY_POLICY,
        "concurrency": concurrency,
        "collectionSha256": hashlib.sha256(COLLECTION.read_bytes()).hexdigest(),
        "sourceSha256": {
            name: hashlib.sha256(
                Path(__file__).with_name(name).read_bytes()
            ).hexdigest()
            for name in (
                "judge_collection.py",
                "judge_report.py",
                "support_grading.py",
                "openrouter_judge.py",
                "judge_inputs.py",
                "judge_types.py",
                "judge_errors.py",
            )
        },
    }
    report = new_report(cases, metadata)
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    for suffix in (".json", ".jsonl", ".html", ".xml"):
        if destination.with_suffix(suffix).exists():
            raise ValueError(
                "Report already exists: " + str(destination.with_suffix(suffix))
            )
    # Persist the plan before calls and each check before the next check starts.
    with destination.with_suffix(".jsonl").open("x") as evidence:
        evidence.write(json.dumps({"run": report}) + "\n")
        evidence.flush()
        write_reports(destination, report)
        lock = Lock()
        completed: dict[str, CaseResult] = {}

        def checkpoint() -> None:
            report["results"] = [
                completed[case["id"]] for case in cases if case["id"] in completed
            ]
            report["requests"] = summarize_requests(
                [
                    check["actual"]
                    for result in report["results"]
                    for check in result["checks"]
                ]
            )
            write_reports(destination, report)

        def on_check(case_id: str, check: CheckResult) -> None:
            with lock:
                partial = completed.setdefault(
                    case_id, {"id": case_id, "checks": [], "seconds": 0}
                )
                partial["checks"].append(check)
                partial["seconds"] = round(
                    sum(c.get("seconds", 0) for c in partial["checks"]), 2
                )
                evidence.write(json.dumps({"id": case_id, "check": check}) + "\n")
                evidence.flush()
                checkpoint()

        with ThreadPoolExecutor(max_workers=concurrency) as executor:
            futures = {
                executor.submit(evaluate_case, case, on_check): case for case in cases
            }
            for future in as_completed(futures):
                result = future.result()
                with lock:
                    completed[result["id"]] = result
                    evidence.write(json.dumps(result) + "\n")
                    evidence.flush()
                    checkpoint()
                    status = summarize(report)["cases"]
                print(
                    f"Judge {result['id']}: "
                    + ", ".join(f"{n} {s}" for s, n in status.items()),
                    flush=True,
                )
    report["finishedAt"] = datetime.now(UTC).isoformat()
    report["requests"] = summarize_requests(
        [check["actual"] for result in report["results"] for check in result["checks"]]
    )
    write_reports(destination, report)
    print(
        "Cases: " + ", ".join(f"{n} {s}" for s, n in report["summary"]["cases"].items())
    )
    print(
        "Checks: "
        + ", ".join(f"{n} {s}" for s, n in report["summary"]["checks"].items())
    )
    print(f"HTML report: {destination.with_suffix('.html')}")
    print(f"JUnit report: {destination.with_suffix('.xml')}")
    return 0 if report["successful"] else 1
