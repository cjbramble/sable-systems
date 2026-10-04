"""Judge authored validation cases or retained chatbot samples, sequentially."""

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import importlib.metadata
import json
from pathlib import Path
import sys
import time

from openrouter_judge import ROOT, judge_metadata, RETRY_POLICY, summarize_requests
from benchmark_review import validate_qualification
from support_grading import GRADING_REVISION, ANSWER_RULES, CLAIM_RULES, judge_answer, judge_claims, judge_direct_claim, EXTRACTION_RULES, assess_claim_coverage


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    payload = json.load(sys.stdin)
    mode = payload["mode"]
    if mode not in ("validation", "transcript", "claims-pilot", "direct-claim-pilot"):
        raise ValueError("Unknown judge run mode")
    concurrency = payload.get("concurrency", 1)
    if type(concurrency) is not int or not 1 <= concurrency <= 4:
        raise ValueError("Judge concurrency must be an integer from 1 to 4")
    suite = payload.get("suite", "legacy")
    if suite not in ("legacy", "coverage", "benchmark", "claims", "extraction", "qualification", "qualification-v2", "qualification-v3", "qualification-v4", "calibration", "calibration-v2", "quality", "record-access", "record-access-v2"):
        raise ValueError("Unknown judge suite")
    if suite != "legacy" and (mode != "validation" or payload.get("validationSet", "all") != "all"):
        raise ValueError("Expanded suites require normal validation mode")
    suite_path = ROOT / "tests/fixtures/judge" / ({"qualification-v4": "qualification-v4.json", "qualification-v3": "qualification-v3.json", "qualification-v2": "qualification-v2.json", "calibration-v2": "qualification-v2.json", "qualification": "qualification-v1.json", "calibration": "qualification-v1.json", "quality": "quality-controls-v1.json", "record-access": "record-access-controls-v1.json", "record-access-v2": "record-access-controls-v2.json", "coverage": "coverage-v3.json", "benchmark": "benchmark-candidate.json", "claims": "claim-controls-v2.json", "extraction": "extraction-controls-v1.json"}.get(suite, "coverage.json"))
    suite_fixture = json.loads(suite_path.read_text()) if suite != "legacy" else None
    freeze = None
    if suite == "benchmark":
        raise ValueError("Use the original evaluate.py for the frozen benchmark")
    labeled = mode != "transcript"
    pilot = mode in ("claims-pilot", "direct-claim-pilot")
    judge = {"claims-pilot": judge_claims, "direct-claim-pilot": judge_direct_claim}.get(mode, judge_answer)
    if suite in ("claims", "extraction"):
        judge = judge_direct_claim if suite == "claims" else judge_claims
    metric_name = {"claims-pilot": "FaithfulnessClaimPipeline", "direct-claim-pilot": "FaithfulnessVerdictStage"}.get(mode, "StructuredSupportAssessment")
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
    live_path = ROOT / "tests/fixtures/judge/live-support-scenarios.json"
    live_scenarios = {row["id"]: row for row in json.loads(live_path.read_text())["scenarios"]} if mode == "transcript" else {}
    if mode == "transcript" and set(payload.get("batches", {})) - {"case-pack", "comparison", *live_scenarios}:
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
                if suite == "extraction":
                    assess_claim_coverage(row["text"], row.get("expectedClaims"), row.get("expectedClaims", []))
    planned = []
    scenarios = {row["id"]: row for row in suite_fixture["scenarios"]} if suite_fixture else {"case-pack": None, "comparison": None}
    if mode == "transcript":
        scenarios.update({name: None for name in live_scenarios if name in payload.get("batches", {})})
    for scenario, authored in scenarios.items():
        if pilot and scenario != "case-pack":
            continue
        live = live_scenarios.get(scenario)
        batch = payload.get("batches", {}).get(scenario)
        if mode == "transcript" and batch is None:
            continue
        fixture_path = live_path if live else suite_path if authored else ROOT / f"tests/fixtures/judge/{scenario}.json"
        fixture = {"question": authored["question"], "references": [authored["reference"]], "examples": authored["examples"]} if authored else {"question": live["messages"][-1]["content"], "references": [batch.get("reference")]} if live else json.loads(fixture_path.read_text())
        if live and (not isinstance(fixture["references"][0], str) or not fixture["references"][0].strip()):
            raise ValueError("Live scenario requires its captured authorized reference")
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
    if suite in ("qualification", "qualification-v2", "qualification-v3", "qualification-v4"):
        freeze = validate_qualification(ROOT, model_metadata, generation, concurrency,
                                        version={"qualification": 1, "qualification-v2": 2, "qualification-v3": 3, "qualification-v4": 4}[suite])
    report = {
        "schemaVersion": 4, "mode": mode, "model": model_metadata,
        "concurrency": concurrency,
        "suite": suite,
        "suiteStatus": "retired-calibration" if suite in ("calibration", "calibration-v2") else suite_fixture["status"] if suite_fixture else "reused-calibration",
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
                   "evaluationSteps": None,
                   "gradingRevision": 3 if claim_diagnostic else GRADING_REVISION,
                   "extractionRevision": 1 if suite == "extraction" or mode == "claims-pilot" else None,
                   "extractionRules": EXTRACTION_RULES if suite == "extraction" or mode == "claims-pilot" else None,
                   "assessmentRules": CLAIM_RULES if claim_diagnostic else ANSWER_RULES},
        "generation": generation,
        "retryPolicy": RETRY_POLICY,
        "evaluatorSha256": {
            **{name: hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest()
               for name in ("openrouter_judge.py", "evaluate.py", "evaluate_support.py", "support_grading.py", "uv.lock")},
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
        answer = row["text"] if labeled else row["answer"]
        result = {
            "scenario": scenario, "id": row.get("id", row.get("sample")),
            "answer": answer, "reference": fixture["references"][0],
            "sourceRequest": payload.get("batches", {}).get(scenario, {}).get("request") if mode == "transcript" else None,
            "fixtureSha256": hashlib.sha256(fixture_path.read_bytes()).hexdigest(),
            "expectedPassed": row.get("correct") if labeled else None,
            "expectedVerdict": row.get("expectedVerdict") if mode == "direct-claim-pilot" or suite == "claims" else None,
            "expectedClaims": row.get("expectedClaims") if suite == "extraction" else None,
            "claimCoverageReviewRequired": suite == "extraction",
            "expectedTaskComplete": row.get("expectedTaskComplete"),
            "expectedDimensions": row.get("expectedDimensions"),
            "factualPassed": row.get("passed") if mode == "transcript" else None,
            "failure": row.get("failure"),
        }
        try:
            if not labeled and (row.get("failure") or {}).get("phase") in ("inference", "response-format"):
                result["executionPhase"] = "generator"
                raise RuntimeError("Generator did not produce a usable answer: " + row["failure"]["error"])
            result.update(judge(fixture["question"], answer, fixture["references"][0]))
            result["agrees"] = result["passed"] == row["correct"] if labeled else None
            result["judgeApplicationAgrees"] = result["passed"] == row["passed"] if not labeled else None
            if suite == "extraction":
                result["supportAgrees"] = result["agrees"]
                result["claimCoverage"] = assess_claim_coverage(answer, row["expectedClaims"], result["claims"])
                result["agrees"] = result["agrees"] and result["claimCoverage"]["passed"]
            if row.get("expectedDimensions") is not None:
                result["dimensionAgreement"] = {key: result["dimensions"][key] == value for key, value in row["expectedDimensions"].items()}
                result["agrees"] = result["agrees"] and all(result["dimensionAgreement"].values())
            if mode == "direct-claim-pilot" or suite == "claims":
                result["agrees"] = result["agrees"] and result["verdicts"][0]["verdict"] == row["expectedVerdict"]
        except Exception as error:
            result.setdefault("executionPhase", "judge")
            result["error"] = f"{type(error).__name__}: {error}"
            result["calls"] = getattr(error, "judge_calls", [])
        result["seconds"] = round(time.monotonic() - started, 2)
        return result

    destination = Path(args.output)
    destination.parent.mkdir(parents=True, exist_ok=True)
    # Exclusive files and incremental records preserve failures and interrupted runs.
    with destination.with_suffix(".jsonl").open("x") as evidence:
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
                "falseAcceptances": sum(row.get("expectedPassed") is False and row.get("passed") is True for row in completed),
                "falseRejections": sum(row.get("expectedPassed") is True and row.get("passed") is False for row in completed),
                "labelDisagreements": sum(row.get("agrees") is False for row in completed),
                "supportLabelDisagreements": sum(row.get("supportAgrees") is False for row in completed),
                "extractionFailures": sum(row.get("claimCoverage", {}).get("passed") is False for row in completed),
                "expectedClaims": sum(len(row.get("expectedClaims") or []) for row in rows),
                "coveredClaims": sum(bool(item["extractedIndices"]) for row in completed for item in row.get("claimCoverage", {}).get("matches", [])),
                "unassessedClaims": sum(len(row.get("expectedClaims") or []) for row in rows if "claimCoverage" not in row),
                "missingClaims": sum(len(row.get("claimCoverage", {}).get("missingClaims", [])) for row in completed),
                "nonSourceQuotes": sum(len(row.get("claimCoverage", {}).get("nonSourceQuotes", [])) for row in completed),
                "unmatchedClaims": sum(len(row.get("claimCoverage", {}).get("unmatchedClaims", [])) for row in completed),
                "factualFailures": sum(row.get("factualPassed") is False for row in rows),
                "judgeRejections": sum(row.get("passed") is False for row in completed),
                "dimensionDisagreements": {key: sum(row.get("dimensionAgreement", {}).get(key) is False for row in completed)
                                            for key in ("factualSupport", "taskCompleteness", "answerQuality")},
                "claimVerdicts": {key: sum(v["verdict"] == key for row in completed for v in row.get("verdicts", []))
                                  for key in ("yes", "no", "idk")}}
    report["summary"] = {"overall": summarize(results),
                         "byScenario": {scenario: summarize([row for row in results if row["scenario"] == scenario])
                                        for scenario in report["coverage"]["expectedScenarios"]}}
    report["executionSuccessful"] = len(results) == report["coverage"]["expectedSamples"] and not report["summary"]["overall"]["executionErrors"]
    report["judgeApplicationAgreementSuccessful"] = all(row.get("judgeApplicationAgrees") is True for row in results) if not labeled else None
    report["factualSuccessful"] = all(row["factualPassed"] is True for row in results) if not labeled else None
    report["labelAgreementSuccessful"] = all(row.get("agrees") is True for row in results) if labeled else None
    report["extractionSuccessful"] = all(row.get("claimCoverage", {}).get("passed") is True for row in results) if suite == "extraction" else None
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
    print(f"Judge incomplete responses: {summary['incompleteResponseAttempts']}; "
          f"recovered requests: {summary['recoveredIncompleteResponseRequests']}; "
          f"unresolved: {summary['unresolvedIncompleteResponseRequests']}")
    print(f"Judge report: {destination}")
    # Live judge verdicts are advisory; harness errors and factual failures are not.
    return 0 if report["successful"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
