"""Judge the current case collection or captured chatbot samples."""

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import importlib.metadata
import json
from pathlib import Path
import sys
import time

from openrouter_judge import ROOT, judge_metadata, RETRY_POLICY, summarize_requests
from support_grading import GRADING_REVISION, ANSWER_RULES, judge_answer


def _validate_samples(samples, scenario):
    if not isinstance(samples, list):
        raise ValueError(f"Scenario samples must be a list: {scenario}")
    if not samples:
        raise ValueError(f"Scenario has no samples: {scenario}")
    if any(not isinstance(sample, dict) for sample in samples):
        raise ValueError(f"Each sample must be an object: {scenario}")
    ids = [sample.get("sample") for sample in samples]
    if any(value is None for value in ids):
        raise ValueError(f"Missing sample IDs: {scenario}")
    if any(type(value) is not int or value < 1 for value in ids):
        raise ValueError(f"Sample IDs must be positive integers: {scenario}")
    if len(set(ids)) != len(ids):
        raise ValueError(f"Missing or duplicate sample IDs: {scenario}")
    for sample in samples:
        label = f"{scenario}/{sample['sample']}"
        if type(sample.get("passed")) is not bool:
            raise ValueError(f"Sample passed must be a boolean: {label}")
        failure = sample.get("failure")
        if failure is not None:
            if not isinstance(failure, dict):
                raise ValueError(f"Sample failure must be an object: {label}")
            if failure.get("phase") not in ("inference", "response-format", "factuality"):
                raise ValueError(f"Invalid sample failure phase: {label}")
            if not isinstance(failure.get("error"), str) or not failure["error"].strip():
                raise ValueError(f"Sample failure requires an error message: {label}")
            if sample["passed"]:
                raise ValueError(f"Passing sample cannot contain a failure: {label}")
        if "answer" not in sample:
            raise ValueError(f"Sample requires an answer field: {label}")
        answer = sample["answer"]
        generator_failed = failure is not None and failure["phase"] in ("inference", "response-format")
        if generator_failed:
            if answer is not None and not isinstance(answer, str):
                raise ValueError(f"Failed generator sample answer must be a string or null: {label}")
        elif not isinstance(answer, str) or not answer.strip():
            raise ValueError(f"Sample answer must be a nonempty string: {label}")


def main():
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
        raise ValueError("Transcript mode cannot select collection categories or list cases")
    concurrency = payload.get("concurrency", 1)
    if type(concurrency) is not int or not 1 <= concurrency <= 4:
        raise ValueError("Judge concurrency must be an integer from 1 to 4")
    live_path = ROOT / "tests/fixtures/judge/live-support-scenarios.json"
    live_scenarios = {row["id"]: row for row in json.loads(live_path.read_text())["scenarios"]}
    batches = payload.get("batches", {})
    if not isinstance(batches, dict):
        raise ValueError("Transcript batches must be an object")
    if set(batches) - {"case-pack", "comparison", *live_scenarios}:
        raise ValueError("Transcript contains unsupported scenarios")
    planned = []
    for scenario, batch in batches.items():
        if not isinstance(batch, dict):
            raise ValueError(f"Scenario batch must be an object: {scenario}")
        live = live_scenarios.get(scenario)
        fixture_path = live_path if live else ROOT / f"tests/fixtures/judge/{scenario}.json"
        fixture = {"question": live["messages"][-1]["content"], "references": [batch.get("reference")]} if live else json.loads(fixture_path.read_text())
        if live and (not isinstance(fixture["references"][0], str) or not fixture["references"][0].strip()):
            raise ValueError("Live scenario requires its captured authorized reference")
        rows = batch.get("samples")
        _validate_samples(rows, scenario)
        planned.append((scenario, fixture_path, fixture, rows))
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
    report = {
        "schemaVersion": 4, "mode": mode, "model": model_metadata,
        "concurrency": concurrency,
        "deepevalVersion": importlib.metadata.version("deepeval"),
        "policy": {"mode": "advisory", "metric": "StructuredSupportAssessment",
                   "strictMode": True, "gradingRevision": GRADING_REVISION,
                   "assessmentRules": ANSWER_RULES},
        "generation": generation,
        "retryPolicy": RETRY_POLICY,
        "evaluatorSha256": {
            **{name: hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest()
               for name in ("openrouter_judge.py", "evaluate_support.py", "support_grading.py", "uv.lock")},
            "openrouter-config.json": hashlib.sha256((ROOT / "lib/openrouter-config.json").read_bytes()).hexdigest(),
        },
        "sourceTranscript": payload.get("sourceTranscript"),
        "sourceSha256": payload.get("sourceSha256"),
        "coverage": {"expectedScenarios": [item[0] for item in planned],
                     "expectedSamples": sum(len(item[3]) for item in planned)},
        "results": [],
    }
    def evaluate_row(scenario, fixture_path, fixture, row):
        started = time.monotonic()
        answer = row["answer"]
        result = {
            "scenario": scenario, "id": row["sample"],
            "answer": answer, "reference": fixture["references"][0],
            "sourceRequest": batches[scenario].get("request"),
            "fixtureSha256": hashlib.sha256(fixture_path.read_bytes()).hexdigest(),
            "factualPassed": row["passed"], "failure": row.get("failure"),
        }
        try:
            if (row.get("failure") or {}).get("phase") in ("inference", "response-format"):
                result["executionPhase"] = "generator"
                raise RuntimeError("Generator did not produce a usable answer: " + row["failure"]["error"])
            result.update(judge_answer(fixture["question"], answer, fixture["references"][0]))
            result["judgeApplicationAgrees"] = result["passed"] == row["passed"]
        except Exception as error:
            result.setdefault("executionPhase", "judge")
            result["error"] = f"{type(error).__name__}: {error}"
            result.setdefault("calls", getattr(error, "judge_calls", []))
        result["seconds"] = round(time.monotonic() - started, 2)
        return result

    destination.parent.mkdir(parents=True, exist_ok=True)
    # Exclusive files and incremental records preserve failures and interrupted runs.
    with evidence_path.open("x") as evidence:
        evidence.write(json.dumps({"run": report}) + "\n")
        evidence.flush()
        tasks = [(scenario, path, fixture, row) for scenario, path, fixture, rows in planned for row in rows]
        with ThreadPoolExecutor(max_workers=concurrency) as executor:
            pending = {executor.submit(evaluate_row, *task): index for index, task in enumerate(tasks)}
            completed = {}
            for future in as_completed(pending):
                result = future.result()
                completed[pending[future]] = result
                evidence.write(json.dumps(result) + "\n")
                evidence.flush()
                print(f"Judge {result['scenario']}/{result['id']}: {result.get('error') or result.get('passed')} ({result['seconds']}s)", flush=True)
            report["results"] = [completed[index] for index in range(len(tasks))]
    results = report["results"]
    report["coverage"].update({"processedScenarios": list(dict.fromkeys(row["scenario"] for row in results)),
                               "processedSamples": len(results)})
    def summarize(rows):
        completed = [row for row in rows if "error" not in row]
        return {**summarize_requests(rows), "samples": len(rows), "executionErrors": len(rows) - len(completed),
                "applicationFailures": sum(row.get("factualPassed") is False and row.get("executionPhase") != "generator" for row in rows),
                "judgeApplicationDisagreements": sum(row.get("judgeApplicationAgrees") is False for row in completed),
                "generatorExecutionErrors": sum(row.get("executionPhase") == "generator" for row in rows),
                "judgeExecutionErrors": sum(row.get("executionPhase") == "judge" for row in rows),
                "factualFailures": sum(row.get("factualPassed") is False for row in rows),
                "judgeRejections": sum(row.get("passed") is False for row in completed)}
    report["summary"] = {"overall": summarize(results),
                         "byScenario": {scenario: summarize([row for row in results if row["scenario"] == scenario])
                                        for scenario in report["coverage"]["expectedScenarios"]}}
    report["executionSuccessful"] = len(results) == report["coverage"]["expectedSamples"] and not report["summary"]["overall"]["executionErrors"]
    report["judgeApplicationAgreementSuccessful"] = all(row.get("judgeApplicationAgrees") is True for row in results)
    report["factualSuccessful"] = all(row["factualPassed"] is True for row in results)
    report["successful"] = report["executionSuccessful"] and bool(results) and report["factualSuccessful"]
    with destination.open("x") as output:
        json.dump(report, output, indent=2)
        output.write("\n")
    summary = report["summary"]["overall"]
    print(f"Judge HTTP attempts: {summary['requestAttempts']}; retries: {summary['retryAttempts']}; "
          f"rate-limited requests recovered: {summary['recoveredRateLimitedRequests']}; "
          f"unresolved: {summary['unresolvedRateLimitedRequests']}")
    print(f"Judge incomplete responses: {summary['incompleteResponseAttempts']}; "
          f"recovered requests: {summary['recoveredIncompleteResponseRequests']}; "
          f"unresolved: {summary['unresolvedIncompleteResponseRequests']}")
    print(f"Judge report: {destination}")
    # Live judge verdicts are advisory; harness errors and factual failures are not.
    return 0 if report["successful"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
