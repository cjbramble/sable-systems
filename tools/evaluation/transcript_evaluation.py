"""Plan and execute judging of captured chatbot samples."""

import hashlib
import json
import time
from collections.abc import Callable
from pathlib import Path
from typing import Literal

from evaluator_provenance import evaluator_provenance
from judge_errors import error_calls, error_message
from judge_inputs import (
    ConversationMessage,
    FixtureInput,
    PlannedScenario,
    TranscriptInput,
    TranscriptSample,
)
from judge_settings import ROOT, judge_metadata
from judge_types import TranscriptReport, TranscriptResult
from openrouter_transport import RETRY_POLICY
from support_grading import GRADING_REVISION, METRIC_CONFIGURATION, judge_answer
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
        # Live scenarios have no fixture reference; the captured records message
        # below is their only reference source.
        fixture: FixtureInput | None = None
        if live:
            question = live["messages"][-1]["content"]
        else:
            fixture = FixtureInput.model_validate_json(fixture_path.read_text())
            question = fixture.question
        history: list[ConversationMessage] = []
        policy = None
        reference_source: Literal["captured", "fixture"] = "fixture"
        request = batch.request
        if isinstance(request, dict) and "messages" in request:
            messages = request["messages"]
            if not isinstance(messages, list) or len(messages) < 2:
                raise ValueError(
                    "Captured request requires policy and customer messages"
                )
            system = messages[0]
            if (
                not isinstance(system, dict)
                or system.get("role") != "system"
                or not isinstance(system.get("content"), str)
                or not system["content"].strip()
            ):
                raise ValueError("Captured request requires a nonempty system policy")
            start = 1
            if len(messages) >= 3 and isinstance(messages[1], dict):
                try:
                    records = json.loads(messages[1].get("content", ""))
                except (TypeError, ValueError):
                    records = None
                if (
                    isinstance(records, dict)
                    and records.get("source") == "authorized_support_records"
                ):
                    if messages[1].get("role") != "user":
                        raise ValueError(
                            "Captured records require the data-message role"
                        )
                    fixture = FixtureInput.model_validate(
                        {
                            "question": question,
                            "references": [records.get("records")],
                        }
                    )
                    policy = system["content"]
                    reference_source = "captured"
                    start = 2
            if len(messages) >= 3 and start != 2:
                raise ValueError(
                    "Captured request has missing or malformed authorized records"
                )
            dialogue = [
                ConversationMessage.model_validate(message)
                for message in messages[start:]
            ]
            if dialogue[-1].role != "user" or dialogue[-1].content != question:
                raise ValueError("Captured final question does not match the scenario")
            history = dialogue[:-1]
        if fixture is None:
            raise ValueError("Live scenario requires its captured authorized records")
        planned.append(
            PlannedScenario(
                scenario,
                fixture_path,
                fixture,
                batch,
                history,
                policy,
                reference_source,
            )
        )
    if not planned:
        raise ValueError("No scenarios selected")
    return planned


def new_report(
    transcript: TranscriptInput, planned: list[PlannedScenario]
) -> TranscriptReport:
    model_metadata, generation = judge_metadata()
    provenance = evaluator_provenance(
        "openrouter_judge.py",
        "openrouter_transport.py",
        "judge_runtime.py",
        "judge_settings.py",
        "evaluate_support.py",
        "transcript_evaluation.py",
        "transcript_report.py",
        "request_summary.py",
        "support_grading.py",
        "judge_inputs.py",
        "judge_types.py",
        "judge_errors.py",
    )
    return {
        "schemaVersion": 5,
        "mode": transcript.mode,
        "model": model_metadata,
        "concurrency": transcript.concurrency,
        "deepevalVersion": provenance.dependency_versions["deepeval"],
        "dependencyVersions": provenance.dependency_versions,
        "policy": {
            "mode": "advisory",
            "metric": "DeepEval GEval: Factual support, Task completeness, Support policy",
            "strictMode": True,
            "gradingRevision": GRADING_REVISION,
            "metricConfiguration": METRIC_CONFIGURATION,
        },
        "generation": generation,
        "retryPolicy": RETRY_POLICY,
        "evaluatorSha256": provenance.source_sha256,
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
        "referenceSource": plan.reference_source,
        "outputTrack": "raw-model",
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
        if plan.history or plan.policy:
            result.update(
                judge_answer(
                    plan.fixture.question,
                    answer,
                    plan.fixture.references[0],
                    history=[message.model_dump() for message in plan.history],
                    policy=plan.policy,
                )
            )
        else:
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
    """Checkpoint each sample before entering the next DeepEval run."""
    if concurrency != 1:
        raise ValueError("DeepEval runs require concurrency=1")
    results: list[TranscriptResult] = []
    for plan in planned:
        for row in plan.batch.samples:
            result = evaluate_sample(plan, row)
            on_result(result)
            results.append(result)
    return results


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
    print(
        f"Judge provider errors: {summary['providerErrorAttempts']}; "
        f"recovered requests: {summary['recoveredProviderErrorRequests']}; "
        f"unresolved: {summary['unresolvedProviderErrorRequests']}"
    )
    print(f"Judge report: {destination}")
    # Live judge verdicts are advisory; harness errors and factual failures are not.
    return 0 if report["successful"] else 1
