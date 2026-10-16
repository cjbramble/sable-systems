"""Native DeepEval/TypeSafe integration over the audited OpenRouter transport."""

import http.client
import json
import os
from collections.abc import Iterator
from contextlib import contextmanager
from typing import TYPE_CHECKING

from judge_runtime import initialize_runtime
from judge_settings import DEFAULTS, JEV_MODEL
from judge_types import RequestRecord
from openrouter_transport import request_response

if TYPE_CHECKING:
    from openrouter_judge import OpenRouterJudge

initialize_runtime()

# Privacy settings must precede framework imports even when used independently.
# isort: split
import httpx2  # noqa: E402
from deepeval.models import TypeSafeModel  # noqa: E402
from typesafe_sdk import RetryPolicy, SystemOneResponse, TypeSafeError  # noqa: E402


class SystemOneTransport(httpx2.BaseTransport):
    def __init__(self, requests: list[RequestRecord]) -> None:
        self.requests = requests

    def handle_request(self, request: httpx2.Request) -> httpx2.Response:
        if (
            request.method != "POST"
            or str(request.url) != "https://openrouter.ai/api/v1/systemone"
        ):
            raise PermissionError("Unexpected System One destination")
        body = json.loads(request.read())
        body["provider"] = DEFAULTS["judgeProvider"]

        def parse(raw: bytes, record: RequestRecord, key: str) -> httpx2.Response:
            redacted = raw.decode().replace(key, "[REDACTED]")
            record["response"] = json.loads(redacted)
            record.pop("rawResponse", None)
            response = httpx2.Response(200, content=redacted, request=request)
            # Use the SDK's schema before reporting success or retry recovery.
            validated = SystemOneResponse.from_http_response(response)
            if set(validated.nouls) != set(body["questions"]):
                raise ValueError("Jev returned an incomplete answer inventory")
            if any(not 0 <= answer.noul <= 1 for answer in validated.nouls.values()):
                raise ValueError("Jev returned a probability outside [0, 1]")
            record["completed"] = True
            return response

        try:
            return request_response(body, self.requests, "/api/v1/systemone", parse)
        except (RuntimeError, OSError, ValueError, http.client.HTTPException) as error:
            # Let DeepEval's documented hybrid fallback handle transport failures.
            # Only safe exception metadata enters the SDK's fallback reason.
            raise TypeSafeError(
                f"OpenRouter System One request failed ({type(error).__name__})"
            ) from error


@contextmanager
def jev_model(judge: "OpenRouterJudge") -> Iterator[TypeSafeModel]:
    key = os.environ.get("OPENROUTER_API_KEY", "").strip()
    if not key:
        raise ValueError("OPENROUTER_API_KEY is required for hybrid evaluation")
    with httpx2.Client(
        transport=SystemOneTransport(judge.requests), trust_env=False
    ) as client:
        yield TypeSafeModel(
            model=JEV_MODEL,
            api_key=key,
            base_url="https://openrouter.ai/api",
            cost_per_input_token=0.042 / 1_000_000,
            http_client=client,
            compression=False,
            retry=RetryPolicy(max_retries=0),
        )
