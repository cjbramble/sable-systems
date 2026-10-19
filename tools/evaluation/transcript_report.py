"""Summaries and final status for advisory transcript reports."""

from judge_types import TranscriptReport, TranscriptResult, TranscriptSummary
from request_summary import summarize_requests


def _answered(rows: list[TranscriptResult]) -> list[TranscriptResult]:
    # A failed model call has no answer to be wrong; execution errors count it.
    return [row for row in rows if row.get("executionPhase") != "generator"]


def summarize(rows: list[TranscriptResult]) -> TranscriptSummary:
    completed = [row for row in rows if "error" not in row]
    answered = _answered(rows)
    return {
        **summarize_requests(rows),
        "samples": len(rows),
        "executionErrors": len(rows) - len(completed),
        "applicationFailures": sum(
            row.get("factualPassed") is False for row in answered
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
        "factualFailures": sum(row.get("factualPassed") is False for row in answered),
        "judgeRejections": sum(row.get("passed") is False for row in completed),
    }


def complete_report(report: TranscriptReport, results: list[TranscriptResult]) -> None:
    report["results"] = results
    report["coverage"].update(
        {
            "processedScenarios": list(
                dict.fromkeys(row["scenario"] for row in results)
            ),
            "processedSamples": len(results),
        }
    )

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
    report["factualSuccessful"] = all(
        row["factualPassed"] is True for row in _answered(results)
    )
    report["successful"] = (
        report["executionSuccessful"] and bool(results) and report["factualSuccessful"]
    )
