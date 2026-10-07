"""Judge execution errors retain evidence without mutating third-party exceptions."""

from collections.abc import Sequence

from judge_types import RequestRecord


class JudgeError(RuntimeError):
    def __init__(self, cause: Exception, calls: Sequence[RequestRecord]) -> None:
        super().__init__(f"{type(cause).__name__}: {cause}")
        self.cause = cause
        self.calls = list(calls)


def error_message(error: Exception) -> str:
    """Keep report error classifications compatible with the original exception."""
    if isinstance(error, JudgeError):
        return str(error)
    return f"{type(error).__name__}: {error}"


def error_calls(error: Exception) -> list[RequestRecord]:
    return error.calls if isinstance(error, JudgeError) else []
