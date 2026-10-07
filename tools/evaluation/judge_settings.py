"""Judge settings and report metadata, without initializing the SDK."""

import json
import os
from pathlib import Path

from judge_types import GenerationSettings, ModelMetadata, ReasoningSettings

ROOT = Path(__file__).resolve().parents[2]
DEFAULTS = json.loads((ROOT / "lib/openrouter-config.json").read_text())
GENERATION: GenerationSettings = {
    "temperature": 0,
    "top_p": 1,
    "max_tokens": 16384,
    "stream": False,
}


def judge_config() -> tuple[str, str, GenerationSettings]:
    model = (
        os.environ.get("OPENROUTER_JUDGE_MODEL", "").strip() or DEFAULTS["judgeModel"]
    )
    reasoning = (
        os.environ.get("OPENROUTER_JUDGE_REASONING", "").strip().lower() or "true"
    )
    if reasoning not in ("true", "false"):
        raise ValueError("OPENROUTER_JUDGE_REASONING must be true or false")
    effort = os.environ.get("OPENROUTER_JUDGE_REASONING_EFFORT", "").strip().lower()
    default_glm = model == DEFAULTS["judgeModel"]
    efforts = (
        ("low", "high", "max")
        if default_glm
        else ("minimal", "low", "medium", "high", "xhigh", "max")
    )
    if effort and (effort not in efforts or reasoning == "false"):
        raise ValueError(
            "OPENROUTER_JUDGE_REASONING_EFFORT must be "
            + ", ".join(efforts)
            + " with reasoning enabled"
        )
    reasoning_settings: ReasoningSettings = {"enabled": reasoning == "true"}
    if reasoning == "true" and (effort or default_glm):
        reasoning_settings["effort"] = effort or "high"
    try:
        max_tokens = int(
            os.environ.get("OPENROUTER_JUDGE_MAX_TOKENS", "").strip()
            or GENERATION["max_tokens"]
        )
    except ValueError:
        raise ValueError(
            "OPENROUTER_JUDGE_MAX_TOKENS must be an integer from 256 to 32768"
        ) from None
    if not 256 <= max_tokens <= 32768:
        raise ValueError(
            "OPENROUTER_JUDGE_MAX_TOKENS must be an integer from 256 to 32768"
        )
    generation = GENERATION.copy()
    generation.update(
        {
            "max_tokens": max_tokens,
            "reasoning": reasoning_settings,
            "provider": DEFAULTS["judgeProvider"],
        }
    )
    return "openrouter", model, generation


def judge_metadata() -> tuple[ModelMetadata, GenerationSettings]:
    provider, model, generation = judge_config()
    return {"provider": provider, "alias": model}, generation
