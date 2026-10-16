"""Record evaluator dependencies and sources without importing their SDKs."""

import hashlib
import importlib.metadata
from dataclasses import dataclass
from pathlib import Path

from judge_settings import ROOT


@dataclass(frozen=True)
class EvaluatorProvenance:
    dependency_versions: dict[str, str]
    source_sha256: dict[str, str]


def evaluator_provenance(*source_names: str) -> EvaluatorProvenance:
    sources = {
        name: hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest()
        for name in (*source_names, "evaluator_provenance.py", "uv.lock")
    }
    sources["openrouter-config.json"] = hashlib.sha256(
        (ROOT / "lib/openrouter-config.json").read_bytes()
    ).hexdigest()
    return EvaluatorProvenance(
        dependency_versions={
            name: importlib.metadata.version(name)
            for name in ("deepeval", "pydantic", "typesafe-sdk", "httpx2")
        },
        source_sha256=sources,
    )
