"""Judge the current case collection or captured chatbot samples."""

import argparse
import hashlib
import importlib.metadata
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from judge_errors import error_calls, error_message
from judge_inputs import (
    FixtureInput,
    PlannedScenario,
    TranscriptInput,
    TranscriptSample,
)
from judge_types import TranscriptReport, TranscriptResult, TranscriptSummary
from openrouter_judge import RETRY_POLICY, ROOT, judge_metadata, summarize_requests
from support_grading import ANSWER_RULES, GRADING_REVISION, judge_answer


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    payload = json.load(sys.stdin)
    if not isinstance(payload, dict):
        raise ValueError("Judge payload must be an object")
    if "suite" in payload:
        raise ValueError("Historical judge suite selection is no longer supported")
    mode = payload.get("mode")
    if mode == "collection":
        from judge_collection import run_collection

        return run_collection(payload, args.output)
    if mode != "transcript":
        raise ValueError("Choose judge mode collection or transcript")
    if payload.get("categories") or payload.get("list"):
        raise ValueError(
            "Transcript mode cannot select collection categories or list cases"
        )
    transcript = TranscriptInput.model_validate(payload)
    concurrency = transcript.concurrency
    live_path = ROOT / "tests/fixtures/judge/live-support-scenarios.json"
    live_scenarios = {
        row["id"]: row for row in json.loads(live_path.read_text())["scenarios"]
    }
    batches = transcript.batches
    if set(batches) - {"case-pack", "comparison", *live_scenarios}:
        raise ValueError("Transcript contains unsupported scenarios")
    planned: list[PlannedScenario] = []
    for scenario, batch in batches.items():
        live = live_scenarios.get(scenario)
        fixture_path = (
            live_path if live else ROOT / f"tests/fixtures/judge/{scenario}.json"
        )
        if live:
            if batch.reference is None:
                raise ValueError(
                    "Live scenario requires its captured authorized reference"
                )
            fixture = FixtureInput.model_validate(
                {
                    "question": live["messages"][-1]["content"],
                    "references": [batch.reference],
                }
            )
        else:
            fixture = FixtureInput.model_validate_json(fixture_path.read_text())
        planned.append(PlannedScenario(scenario, fixture_path, fixture, batch))
    if not planned:
        raise ValueError("No scenarios selected")
    destination = Path(args.output)
    evidence_path = destination.with_suffix(".jsonl")
    if destination == evidence_path:
        raise ValueError("Report and evidence paths must be different")
    for path in (destination, evidence_path):
        if path.exists() or path.is_symlink():
            raise ValueError(f"Report already exists: {path}")
    model_metadata, generation = judge_metadata()
    report: TranscriptReport = {
        "schemaVersion": 4,
        "mode": mode,
        "model": model_metadata,
        "concurrency": concurrency,
        "deepevalVersion": importlib.metadata.version("deepeval"),
        "policy": {
            "mode": "advisory",
            "metric": "StructuredSupportAssessment",
            "strictMode": True,
            "gradingRevision": GRADING_REVISION,
            "assessmentRules": ANSWER_RULES,
        },
        "generation": generation,
        "retryPolicy": RETRY_POLICY,
        "evaluatorSha256": {
            **{
                name: hashlib.sha256(
                    Path(__file__).with_name(name).read_bytes()
                ).hexdigest()
                for name in (
                    "openrouter_judge.py",
                    "evaluate_support.py",
                    "support_grading.py",
                    "judge_inputs.py",
                    "judge_types.py",
                    "judge_errors.py",
                    "uv.lock",
                )
            },
            "openrouter-config.json": hashlib.sha256(
                (ROOT / "lib/openrouter-config.json").read_bytes()
            ).hexdigest(),
        },
        "sourceTranscript": transcript.sourceTranscript,
        "sourceSha256": transcript.sourceSha256,
        "coverage": {
            "expectedScenarios": [item.scenario for item in planned],
            "expectedSamples": sum(len(item.batch.samples) for item in planned),
        },
        "results": [],
    }

    def evaluate_row(plan: PlannedScenario, row: TranscriptSample) -> TranscriptResult:
        started = time.monotonic()
        answer = row.answer
        result: TranscriptResult = {
            "scenario": plan.scenario,
            "id": row.sample,
            "answer": answer,
            "reference": plan.fixture.references[0],
            "sourceRequest": plan.batch.request,
            "fixtureSha256": hashlib.sha256(plan.fixture_path.read_bytes()).hexdigest(),
            "factualPassed": row.passed,
            "failure": row.failure.model_dump(exclude_unset=True)
            if row.failure
            else None,
        }
        try:
            if row.generator_failed:
                result["executionPhase"] = "generator"
                assert row.failure is not None
                raise RuntimeError(
                    "Generator did not produce a usable answer: " + row.failure.error
                )
            assert answer is not None  # Validated for every usable sample.
            result.update(
                judge_answer(plan.fixture.question, answer, plan.fixture.references[0])
            )
            result["judgeApplicationAgrees"] = result["passed"] == row.passed
        except Exception as error:
            result.setdefault("executionPhase", "judge")
            result["error"] = error_message(error)
            result.setdefault("calls", error_calls(error))
        result["seconds"] = round(time.monotonic() - started, 2)
        return result

    destination.parent.mkdir(parents=True, exist_ok=True)
    # Exclusive files and incremental records preserve failures and interrupted runs.
    with evidence_path.open("x") as evidence:
        evidence.write(json.dumps({"run": report}) + "\n")
        evidence.flush()
        tasks = [(plan, row) for plan in planned for row in plan.batch.samples]
        with ThreadPoolExecutor(max_workers=concurrency) as executor:
            pending = {
                executor.submit(evaluate_row, *task): index
                for index, task in enumerate(tasks)
            }
            completed: dict[int, TranscriptResult] = {}
            for future in as_completed(pending):
                result = future.result()
                completed[pending[future]] = result
                evidence.write(json.dumps(result) + "\n")
                evidence.flush()
                print(
                    f"Judge {result['scenario']}/{result['id']}: {result.get('error') or result.get('passed')} ({result['seconds']}s)",
                    flush=True,
                )
            report["results"] = [completed[index] for index in range(len(tasks))]
    results = report["results"]
    report["coverage"].update(
        {
            "processedScenarios": list(
                dict.fromkeys(row["scenario"] for row in results)
            ),
            "processedSamples": len(results),
        }
    )

    def summarize(rows: list[TranscriptResult]) -> TranscriptSummary:
        completed = [row for row in rows if "error" not in row]
        return {
            **summarize_requests(rows),
            "samples": len(rows),
            "executionErrors": len(rows) - len(completed),
            "applicationFailures": sum(
                row.get("factualPassed") is False
                and row.get("executionPhase") != "generator"
                for row in rows
            ),
            "judgeApplicationDisagreements": sum(
                row.get("judgeApplicationAgrees") is False for row in completed
            ),
            "generatorExecutionErrors": sum(
                row.get("executionPhase") == "generator" for row in rows
            ),
            "judgeExecutionErrors": sum(
                row.get("executionPhase") == "judge" for row in rows
            ),
            "factualFailures": sum(row.get("factualPassed") is False for row in rows),
            "judgeRejections": sum(row.get("passed") is False for row in completed),
        }

    report["summary"] = {
        "overall": summarize(results),
        "byScenario": {
            scenario: summarize([row for row in results if row["scenario"] == scenario])
            for scenario in report["coverage"]["expectedScenarios"]
        },
    }
    report["executionSuccessful"] = (
        len(results) == report["coverage"]["expectedSamples"]
        and not report["summary"]["overall"]["executionErrors"]
    )
    report["judgeApplicationAgreementSuccessful"] = all(
        row.get("judgeApplicationAgrees") is True for row in results
    )
    report["factualSuccessful"] = all(row["factualPassed"] is True for row in results)
    report["successful"] = (
        report["executionSuccessful"] and bool(results) and report["factualSuccessful"]
    )
    with destination.open("x") as output:
        json.dump(report, output, indent=2)
        output.write("\n")
    summary = report["summary"]["overall"]
    print(
        f"Judge HTTP attempts: {summary['requestAttempts']}; retries: {summary['retryAttempts']}; "
        f"rate-limited requests recovered: {summary['recoveredRateLimitedRequests']}; "
        f"unresolved: {summary['unresolvedRateLimitedRequests']}"
    )
    print(
        f"Judge incomplete responses: {summary['incompleteResponseAttempts']}; "
        f"recovered requests: {summary['recoveredIncompleteResponseRequests']}; "
        f"unresolved: {summary['unresolvedIncompleteResponseRequests']}"
    )
    print(f"Judge report: {destination}")
    # Live judge verdicts are advisory; harness errors and factual failures are not.
    return 0 if report["successful"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
