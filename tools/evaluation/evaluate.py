"""Judge authored validation cases or retained chatbot samples, sequentially."""

import argparse
import hashlib
import importlib.metadata
import json
from pathlib import Path
import sys
import time

from openrouter_judge import ROOT, STEPS, judge_metadata, judge_answer, judge_claims, judge_direct_claim, RETRY_POLICY, summarize_requests


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    payload = json.load(sys.stdin)
    mode = payload["mode"]
    if mode not in ("validation", "transcript", "claims-pilot", "direct-claim-pilot"):
        raise ValueError("Unknown judge run mode")
    suite = payload.get("suite", "legacy")
    if suite not in ("legacy", "coverage", "benchmark", "claims", "extraction"):
        raise ValueError("Unknown judge suite")
    if suite != "legacy" and (mode != "validation" or payload.get("validationSet", "all") != "all"):
        raise ValueError("Expanded suites require normal validation mode")
    suite_path = ROOT / "tests/fixtures/judge" / ({"coverage": "coverage.json", "benchmark": "benchmark-candidate.json", "claims": "claim-controls.json", "extraction": "claim-controls.json"}.get(suite, "coverage.json"))
    suite_fixture = json.loads(suite_path.read_text()) if suite != "legacy" else None
    freeze = None
    if suite == "benchmark":
        freeze = json.loads((ROOT / "tests/fixtures/judge/benchmark-freeze.json").read_text())
        for name, digest in freeze["sha256"].items():
            if hashlib.sha256((ROOT / name).read_bytes()).hexdigest() != digest:
                raise ValueError(f"Benchmark freeze mismatch: {name}")
    labeled = mode != "transcript"
    pilot = mode in ("claims-pilot", "direct-claim-pilot")
    judge = {"claims-pilot": judge_claims, "direct-claim-pilot": judge_direct_claim}.get(mode, judge_answer)
    if suite in ("claims", "extraction"):
        judge = judge_direct_claim if suite == "claims" else judge_claims
    metric_name = {"claims-pilot": "FaithfulnessClaimPipeline", "direct-claim-pilot": "FaithfulnessVerdictStage"}.get(mode, "GEval")
    if suite in ("claims", "extraction"):
        metric_name = "FaithfulnessVerdictStage" if suite == "claims" else "FaithfulnessClaimPipeline"
    claim_diagnostic = pilot or suite in ("claims", "extraction")
    validation_set = payload.get("validationSet", "all")
    if validation_set not in ("all", "holdout"):
        raise ValueError("Unknown validation set")
    holdout_path = ROOT / "tests/fixtures/judge/holdout.json"
    holdout = json.loads(holdout_path.read_text()) if labeled else None
    direct_path = ROOT / "tests/fixtures/judge/direct-claims.json"
    direct = json.loads(direct_path.read_text()) if mode == "direct-claim-pilot" else None
    if mode == "transcript" and set(payload.get("batches", {})) - {"case-pack", "comparison"}:
        raise ValueError("Transcript contains unsupported scenarios")
    if suite_fixture:
        ids = [row["id"] for row in suite_fixture["scenarios"]]
        if len(set(ids)) != len(ids):
            raise ValueError("Duplicate scenario IDs")
        for scenario in suite_fixture["scenarios"]:
            if not all(isinstance(scenario.get(field), str) and scenario[field].strip() for field in ("id", "question", "reference")):
                raise ValueError("Invalid authored scenario")
            for row in scenario["examples"]:
                if type(row.get("correct")) is not bool or not isinstance(row.get("text"), str) or not row["text"].strip():
                    raise ValueError("Invalid authored example")
    planned = []
    scenarios = {row["id"]: row for row in suite_fixture["scenarios"]} if suite_fixture else {"case-pack": None, "comparison": None}
    for scenario, authored in scenarios.items():
        if pilot and scenario != "case-pack":
            continue
        fixture_path = suite_path if authored else ROOT / f"tests/fixtures/judge/{scenario}.json"
        fixture = {"question": authored["question"], "references": [authored["reference"]], "examples": authored["examples"]} if authored else json.loads(fixture_path.read_text())
        batch = payload.get("batches", {}).get(scenario)
        if mode == "transcript" and batch is None:
            continue
        if authored:
            rows = fixture["examples"]
        elif mode == "direct-claim-pilot":
            if direct["referenceScenario"] != scenario or len(direct["examples"]) != 4:
                raise ValueError("Direct claim pilot requires the quantity and product-identity controls")
            rows = direct["examples"]
        elif mode == "claims-pilot":
            rows = [row for row in fixture["examples"] + holdout["scenarios"][scenario]
                    if row["id"] in ("valid-alternatives", "holdout-unavailable-alternative")]
            if len(rows) != 2:
                raise ValueError("Claim pilot requires both frozen stock-alternative controls")
        elif mode == "validation":
            rows = ([] if validation_set == "holdout" else fixture["examples"]) + holdout["scenarios"][scenario]
        else:
            rows = batch["samples"]
        if not rows:
            raise ValueError(f"Scenario has no samples: {scenario}")
        ids = [row.get("id", row.get("sample")) for row in rows]
        if any(value is None for value in ids) or len(set(ids)) != len(ids):
            raise ValueError(f"Missing or duplicate sample IDs: {scenario}")
        planned.append((scenario, fixture_path, fixture, rows))
    if not planned:
        raise ValueError("No scenarios selected")
    model_metadata, generation = judge_metadata()
    report = {
        "schemaVersion": 2, "mode": mode, "model": model_metadata,
        "suite": suite,
        "suiteStatus": suite_fixture["status"] if suite_fixture else "reused-calibration",
        "suiteSha256": hashlib.sha256(suite_path.read_bytes()).hexdigest() if suite_fixture else None,
        "benchmarkFreeze": freeze,
        "validationSet": validation_set if mode == "validation" else None,
        "holdoutSha256": hashlib.sha256(holdout_path.read_bytes()).hexdigest() if holdout else None,
        "holdoutFrozenAgainst": holdout["frozenAgainst"] if holdout else None,
        "directClaimFixtureSha256": hashlib.sha256(direct_path.read_bytes()).hexdigest() if direct else None,
        "deepevalVersion": importlib.metadata.version("deepeval"),
        "policy": {"mode": "advisory", "metric": metric_name,
                   "referenceMode": "verbatim" if claim_diagnostic else None,
                   "claimVerification": "one-at-a-time" if claim_diagnostic else None,
                   "strictMode": True, "penalizeAmbiguousClaims": True if claim_diagnostic else None,
                   "evaluationSteps": None if claim_diagnostic else STEPS},
        "generation": generation,
        "retryPolicy": RETRY_POLICY,
        "evaluatorSha256": {
            **{name: hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest()
               for name in ("openrouter_judge.py", "evaluate.py", "uv.lock")},
            "openrouter-config.json": hashlib.sha256((ROOT / "lib/openrouter-config.json").read_bytes()).hexdigest(),
        },
        "sourceTranscript": payload.get("sourceTranscript"),
        "sourceSha256": payload.get("sourceSha256"),
        "coverage": {"expectedScenarios": [item[0] for item in planned],
                     "expectedSamples": sum(len(item[3]) for item in planned)},
        "results": [],
    }
    destination = Path(args.output)
    destination.parent.mkdir(parents=True, exist_ok=True)
    # Exclusive files and incremental records preserve failures and interrupted runs.
    with destination.with_suffix(".jsonl").open("x") as evidence:
        evidence.write(json.dumps({"run": report}) + "\n")
        evidence.flush()
        for scenario, fixture_path, fixture, rows in planned:
            for row in rows:
                started = time.monotonic()
                answer = row["text"] if labeled else row["answer"]
                result = {
                    "scenario": scenario, "id": row.get("id", row.get("sample")),
                    "answer": answer, "fixtureSha256": hashlib.sha256(fixture_path.read_bytes()).hexdigest(),
                    "expectedPassed": row.get("correct") if labeled else None,
                    "expectedVerdict": row.get("expectedVerdict") if mode == "direct-claim-pilot" or suite == "claims" else None,
                    "expectedClaims": row.get("expectedClaims") if suite == "extraction" else None,
                    "claimCoverageReviewRequired": suite == "extraction",
                    "expectedTaskComplete": row.get("expectedTaskComplete"),
                    "factualPassed": row.get("passed") if mode == "transcript" else None,
                    "failure": row.get("failure"),
                }
                try:
                    result.update(judge(fixture["question"], answer, fixture["references"][0]))
                    result["agrees"] = result["passed"] == row["correct"] if labeled else None
                    if mode == "direct-claim-pilot" or suite == "claims":
                        result["agrees"] = result["agrees"] and result["verdicts"][0]["verdict"] == row["expectedVerdict"]
                except Exception as error:
                    result["error"] = f"{type(error).__name__}: {error}"
                    result["calls"] = getattr(error, "judge_calls", [])
                result["seconds"] = round(time.monotonic() - started, 2)
                report["results"].append(result)
                evidence.write(json.dumps(result) + "\n")
                evidence.flush()
                print(f"Judge {scenario}/{result['id']}: {result.get('error') or result.get('passed')} ({result['seconds']}s)", flush=True)
    results = report["results"]
    report["coverage"].update({"processedScenarios": list(dict.fromkeys(row["scenario"] for row in results)),
                               "processedSamples": len(results)})
    def summarize(rows):
        completed = [row for row in rows if "error" not in row]
        return {**summarize_requests(rows), "samples": len(rows), "executionErrors": len(rows) - len(completed),
                "falseAcceptances": sum(row.get("expectedPassed") is False and row.get("passed") is True for row in completed),
                "falseRejections": sum(row.get("expectedPassed") is True and row.get("passed") is False for row in completed),
                "labelDisagreements": sum(row.get("agrees") is False for row in completed),
                "factualFailures": sum(row.get("factualPassed") is False for row in rows),
                "judgeRejections": sum(row.get("passed") is False for row in completed)}
    report["summary"] = {"overall": summarize(results),
                         "byScenario": {scenario: summarize([row for row in results if row["scenario"] == scenario])
                                        for scenario in report["coverage"]["expectedScenarios"]}}
    report["executionSuccessful"] = len(results) == report["coverage"]["expectedSamples"] and not report["summary"]["overall"]["executionErrors"]
    report["factualSuccessful"] = all(row["factualPassed"] is True for row in results) if not labeled else None
    report["labelAgreementSuccessful"] = all(row.get("agrees") is True for row in results) if labeled else None
    report["successful"] = report["executionSuccessful"] and bool(results) and all(
        "error" not in row and (row["agrees"] if labeled else row["factualPassed"] is True)
        for row in results
    )
    with destination.open("x") as output:
        json.dump(report, output, indent=2)
        output.write("\n")
    summary = report["summary"]["overall"]
    print(f"Judge HTTP attempts: {summary['requestAttempts']}; retries: {summary['retryAttempts']}; "
          f"rate-limited requests recovered: {summary['recoveredRateLimitedRequests']}; "
          f"unresolved: {summary['unresolvedRateLimitedRequests']}")
    print(f"Judge report: {destination}")
    # Live judge verdicts are advisory; harness errors and factual failures are not.
    return 0 if report["successful"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
