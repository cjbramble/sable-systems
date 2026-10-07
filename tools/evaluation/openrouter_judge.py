"""DeepEval adapter for schema-bound OpenRouter judgments."""

import asyncio

from pydantic import BaseModel

from judge_runtime import initialize_runtime
from judge_settings import judge_config
from judge_types import RequestRecord
from openrouter_transport import request_verdict

initialize_runtime()

# Privacy settings and the network guard must precede every DeepEval import.
from deepeval.models import DeepEvalBaseLLM  # noqa: E402


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
