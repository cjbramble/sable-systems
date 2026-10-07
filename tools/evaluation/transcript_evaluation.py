"""Plan and execute judging of captured chatbot samples."""

import hashlib
import importlib.metadata
import json
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from judge_errors import error_calls, error_message
from judge_inputs import (
    FixtureInput,
    PlannedScenario,
    TranscriptInput,
    TranscriptSample,
)
from judge_types import TranscriptReport, TranscriptResult
from openrouter_judge import RETRY_POLICY, ROOT, judge_metadata
from support_grading import ANSWER_RULES, GRADING_REVISION, judge_answer
from transcript_report import complete_report


def plan_transcript(
    transcript: TranscriptInput,
    *,
    fixtures: Path = ROOT / "tests/fixtures/judge",
) -> list[PlannedScenario]:
    """Resolve every fixture before any model configuration, calls, or output."""
    live_path = fixtures / "live-support-scenarios.json"
    live_scenarios = {
        row["id"]: row for row in json.loads(live_path.read_text())["scenarios"]
    }
    batches = transcript.batches
    if set(batches) - {"case-pack", "comparison", *live_scenarios}:
        raise ValueError("Transcript contains unsupported scenarios")
    planned: list[PlannedScenario] = []
    for scenario, batch in batches.items():
        live = live_scenarios.get(scenario)
        fixture_path = live_path if live else fixtures / f"{scenario}.json"
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
    return planned


def new_report(
    transcript: TranscriptInput, planned: list[PlannedScenario]
) -> TranscriptReport:
    model_metadata, generation = judge_metadata()
    return {
        "schemaVersion": 4,
        "mode": transcript.mode,
        "model": model_metadata,
        "concurrency": transcript.concurrency,
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
                    "transcript_evaluation.py",
                    "transcript_report.py",
                    "request_summary.py",
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


def evaluate_sample(plan: PlannedScenario, row: TranscriptSample) -> TranscriptResult:
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
        "failure": row.failure.model_dump(exclude_unset=True) if row.failure else None,
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


def execute_transcript(
    planned: list[PlannedScenario],
    *,
    concurrency: int,
    on_result: Callable[[TranscriptResult], None],
) -> list[TranscriptResult]:
    """Publish completions immediately and return results in planned order."""
    tasks = [(plan, row) for plan in planned for row in plan.batch.samples]
    with ThreadPoolExecutor(max_workers=concurrency) as executor:
        pending = {
            executor.submit(evaluate_sample, *task): index
            for index, task in enumerate(tasks)
        }
        completed: dict[int, TranscriptResult] = {}
        for future in as_completed(pending):
            result = future.result()
            completed[pending[future]] = result
            on_result(result)
    return [completed[index] for index in range(len(tasks))]


def run_transcript(transcript: TranscriptInput, destination: Path) -> int:
    planned = plan_transcript(transcript)
    evidence_path = destination.with_suffix(".jsonl")
    if destination == evidence_path:
        raise ValueError("Report and evidence paths must be different")
    for path in (destination, evidence_path):
        if path.exists() or path.is_symlink():
            raise ValueError(f"Report already exists: {path}")
    report = new_report(transcript, planned)
    destination.parent.mkdir(parents=True, exist_ok=True)
    # Exclusive files and incremental records preserve failures and interrupted runs.
    with evidence_path.open("x") as evidence:
        evidence.write(json.dumps({"run": report}) + "\n")
        evidence.flush()

        def on_result(result: TranscriptResult) -> None:
            evidence.write(json.dumps(result) + "\n")
            evidence.flush()
            print(
                f"Judge {result['scenario']}/{result['id']}: {result.get('error') or result.get('passed')} ({result['seconds']}s)",
                flush=True,
            )

        results = execute_transcript(
            planned, concurrency=transcript.concurrency, on_result=on_result
        )
    complete_report(report, results)
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
