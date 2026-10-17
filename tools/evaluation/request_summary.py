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
        if any(
            429 in (call.get("httpStatus"), call.get("upstreamStatus"))
            for call in group
        )
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
    provider_errors = [
        group
        for group in groups
        if any(call.get("retryReason") == "provider-error" for call in group)
    ]
    recovered_provider_errors = sum(
        group[-1].get("completed") is True for group in provider_errors
    )
    return {
        "requestAttempts": len(calls),
        "retryAttempts": sum(call.get("attempt", 1) > 1 for call in calls),
        "rateLimitedAttempts": sum(
            429 in (call.get("httpStatus"), call.get("upstreamStatus"))
            for call in calls
        ),
        "recoveredRateLimitedRequests": recovered,
        "unresolvedRateLimitedRequests": len(limited) - recovered,
        "providerErrorAttempts": sum(
            call.get("retryReason") == "provider-error" for call in calls
        ),
        "recoveredProviderErrorRequests": recovered_provider_errors,
        "unresolvedProviderErrorRequests": len(provider_errors)
        - recovered_provider_errors,
        "incompleteResponseAttempts": sum(
            call.get("httpStatus") == 200 and call.get("errorType") == "IncompleteRead"
            for call in calls
        ),
        "recoveredIncompleteResponseRequests": recovered_incomplete,
        "unresolvedIncompleteResponseRequests": len(incomplete) - recovered_incomplete,
    }
