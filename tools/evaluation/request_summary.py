"""Summarize request evidence without importing the judge runtime."""

from collections.abc import Sequence

from judge_types import RequestEvidence, RequestRecord, RequestSummary


def summarize_requests(rows: Sequence[RequestEvidence]) -> RequestSummary:
    """Count HTTP attempts separately from logical requests and case errors."""
    calls = [call for row in rows for call in row.get("calls", [])]
    groups: list[list[RequestRecord]] = []
    for row in rows:
        requests: dict[int, list[RequestRecord]] = {}
        for index, call in enumerate(row.get("calls", [])):
            requests.setdefault(call.get("logicalRequest", index + 1), []).append(call)
        groups.extend(requests.values())
    limited = [
        group
        for group in groups
        if any(call.get("httpStatus") == 429 for call in group)
    ]
    recovered = sum(group[-1].get("completed") is True for group in limited)
    incomplete = [
        group
        for group in groups
        if any(
            call.get("httpStatus") == 200 and call.get("errorType") == "IncompleteRead"
            for call in group
        )
    ]
    recovered_incomplete = sum(
        group[-1].get("completed") is True for group in incomplete
    )
    return {
        "requestAttempts": len(calls),
        "retryAttempts": sum(call.get("attempt", 1) > 1 for call in calls),
        "rateLimitedAttempts": sum(call.get("httpStatus") == 429 for call in calls),
        "recoveredRateLimitedRequests": recovered,
        "unresolvedRateLimitedRequests": len(limited) - recovered,
        "incompleteResponseAttempts": sum(
            call.get("httpStatus") == 200 and call.get("errorType") == "IncompleteRead"
            for call in calls
        ),
        "recoveredIncompleteResponseRequests": recovered_incomplete,
        "unresolvedIncompleteResponseRequests": len(incomplete) - recovered_incomplete,
    }
