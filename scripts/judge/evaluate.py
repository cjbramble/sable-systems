"""Judge authored validation cases or retained chatbot samples, sequentially."""

import argparse
import hashlib
import importlib.metadata
import json
from pathlib import Path
import sys
import time

from local_judge import GENERATION, MANIFEST, ROOT, STEPS, judge_answer


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    payload = json.load(sys.stdin)
    mode = payload["mode"]
    if mode not in ("validation", "transcript"):
        raise ValueError("Unknown judge run mode")
    validation_set = payload.get("validationSet", "all")
    if validation_set not in ("all", "holdout"):
        raise ValueError("Unknown validation set")
    holdout_path = ROOT / "tests/fixtures/judge/holdout.json"
    holdout = json.loads(holdout_path.read_text()) if mode == "validation" else None
    report = {
        "schemaVersion": 1, "mode": mode, "model": MANIFEST,
        "validationSet": validation_set if mode == "validation" else None,
        "holdoutSha256": hashlib.sha256(holdout_path.read_bytes()).hexdigest() if holdout else None,
        "holdoutFrozenAgainst": holdout["frozenAgainst"] if holdout else None,
        "deepevalVersion": importlib.metadata.version("deepeval"),
        "policy": {"mode": "advisory", "evaluationSteps": STEPS},
        "generation": GENERATION,
        "evaluatorSha256": {name: hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest() for name in ("local_judge.py", "evaluate.py", "uv.lock")},
        "sourceTranscript": payload.get("sourceTranscript"),
        "sourceSha256": payload.get("sourceSha256"),
        "results": [],
    }
    destination = Path(args.output)
    destination.parent.mkdir(parents=True, exist_ok=True)
    # Exclusive files and incremental records preserve failures and interrupted runs.
    with destination.with_suffix(".jsonl").open("x") as evidence:
        evidence.write(json.dumps({"run": report}) + "\n")
        evidence.flush()
        for scenario in ("case-pack", "comparison"):
            fixture_path = ROOT / f"tests/fixtures/judge/{scenario}.json"
            fixture = json.loads(fixture_path.read_text())
            batch = payload.get("batches", {}).get(scenario)
            if mode == "transcript" and batch is None:
                continue
            if mode == "validation":
                rows = ([] if validation_set == "holdout" else fixture["examples"]) + holdout["scenarios"][scenario]
            else:
                rows = batch["samples"]
            for row in rows:
                started = time.monotonic()
                answer = row["text"] if mode == "validation" else row["answer"]
                result = {
                    "scenario": scenario, "id": row.get("id", row.get("sample")),
                    "answer": answer, "fixtureSha256": hashlib.sha256(fixture_path.read_bytes()).hexdigest(),
                    "expectedPassed": row.get("correct") if mode == "validation" else None,
                    "factualPassed": row.get("passed") if mode == "transcript" else None,
                    "failure": row.get("failure"),
                }
                try:
                    result.update(judge_answer(fixture["question"], answer, fixture["references"][0]))
                    result["agrees"] = result["passed"] == row["correct"] if mode == "validation" else None
                except Exception as error:
                    result["error"] = f"{type(error).__name__}: {error}"
                result["seconds"] = round(time.monotonic() - started, 2)
                report["results"].append(result)
                evidence.write(json.dumps(result) + "\n")
                evidence.flush()
                print(f"Judge {scenario}/{result['id']}: {result.get('error') or result.get('passed')} ({result['seconds']}s)", flush=True)
    results = report["results"]
    report["successful"] = bool(results) and all(
        "error" not in row and (row["agrees"] if mode == "validation" else row["factualPassed"] is True)
        for row in results
    )
    with destination.open("x") as output:
        json.dump(report, output, indent=2)
        output.write("\n")
    print(f"Local judge report: {destination}")
    # Live judge verdicts are advisory; harness errors and factual failures are not.
    return 0 if report["successful"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
