"""DeepEval adapter for schema-bound OpenRouter judgments."""

import asyncio
from typing import Annotated, cast

from pydantic import BaseModel, ConfigDict, Field

from judge_runtime import initialize_runtime
from judge_settings import judge_config
from judge_types import RequestRecord
from openrouter_transport import request_verdict

initialize_runtime()

# Privacy settings and the network guard must precede every DeepEval import.
from deepeval.metrics.conversational_g_eval.schema import (  # noqa: E402
    ReasonScore as ConversationScore,
)
from deepeval.metrics.g_eval.schema import ReasonScore as SingleTurnScore  # noqa: E402
from deepeval.models import DeepEvalBaseLLM  # noqa: E402


class BinaryScore(SingleTurnScore):
    """Validate the wire score before DeepEval's strict-mode integer conversion."""

    model_config = ConfigDict(strict=True)
    score: Annotated[int, Field(ge=0, le=1)]


class TenPointScore(ConversationScore):
    model_config = ConfigDict(strict=True)
    score: Annotated[int, Field(ge=0, le=10)]


class OpenRouterJudge(DeepEvalBaseLLM):
    def __init__(self) -> None:
        self.requests: list[RequestRecord] = []
        self.provider, self.model_name, self.generation = judge_config()
        super().__init__()

    def load_model(self) -> str:
        return self.model_name

    def get_model_name(self) -> str:
        return self.model_name

    def generate[Response: BaseModel](
        self,
        prompt: str,
        schema: type[Response] | None = None,
    ) -> Response:
        if schema is None:
            raise ValueError("Judging requires a response schema")
        # These constraints match the pinned SDK's respective prompt contracts.
        if schema is SingleTurnScore:
            schema = cast(type[Response], BinaryScore)
        elif schema is ConversationScore:
            schema = cast(type[Response], TenPointScore)
        body: dict[str, object] = {
            "model": self.model_name,
            "messages": [{"role": "user", "content": prompt}],
            **self.generation,
            "response_format": {
                "type": "json_schema",
                "json_schema": {
                    "name": "judge_verdict",
                    "strict": True,
                    "schema": schema.model_json_schema(),
                },
            },
        }
        return request_verdict(body, schema, self.requests)

    async def a_generate[Response: BaseModel](
        self,
        prompt: str,
        schema: type[Response] | None = None,
    ) -> Response:
        return await asyncio.to_thread(self.generate, prompt, schema)
