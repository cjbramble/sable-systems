"""Strict evaluator inputs, preserving original text and extra source evidence."""

from dataclasses import dataclass
from pathlib import Path
from typing import Annotated, Literal, Self, cast

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    field_validator,
    model_validator,
)

from judge_types import CheckKind, Dimension, JudgeCase, Verdict


def _nonempty(value: str) -> str:
    if not value.strip():
        raise ValueError("Text must be nonempty")
    return value


type NonemptyText = Annotated[str, AfterValidator(_nonempty)]
type Concurrency = Annotated[int, Field(ge=1, le=4)]


class StrictInput(BaseModel):
    # Source transcripts may include additional evidence. Retain it without coercion.
    model_config = ConfigDict(strict=True, extra="allow", hide_input_in_errors=True)


class SampleFailure(StrictInput):
    phase: Literal["inference", "response-format", "factuality"]
    error: NonemptyText


class TranscriptSample(StrictInput):
    sample: Annotated[int, Field(gt=0)]
    answer: str | None
    passed: bool
    failure: SampleFailure | None = None

    @model_validator(mode="after")
    def validate_answer(self) -> Self:
        if self.failure is not None and self.passed:
            raise ValueError("Passing sample cannot contain a failure")
        if not self.generator_failed and (
            self.answer is None or not self.answer.strip()
        ):
            raise ValueError("Sample answer must be a nonempty string")
        return self

    @property
    def generator_failed(self) -> bool:
        return self.failure is not None and self.failure.phase in (
            "inference",
            "response-format",
        )


class TranscriptBatch(StrictInput):
    samples: list[TranscriptSample]
    reference: NonemptyText | None = None
    request: object = None

    @model_validator(mode="after")
    def validate_samples(self) -> Self:
        if not self.samples:
            raise ValueError("Scenario has no samples")
        ids = [sample.sample for sample in self.samples]
        if len(set(ids)) != len(ids):
            raise ValueError("Duplicate sample IDs")
        return self


class TranscriptInput(StrictInput):
    mode: Literal["transcript"]
    concurrency: Concurrency = 1
    batches: dict[str, TranscriptBatch] = Field(default_factory=dict)
    sourceTranscript: str | None = None
    sourceSha256: str | None = None


class CollectionOptions(StrictInput):
    categories: list[str] = Field(default_factory=list)
    list_cases: bool = Field(default=False, alias="list")
    concurrency: Concurrency = 1


class FixtureInput(StrictInput):
    question: NonemptyText
    references: Annotated[list[NonemptyText], Field(min_length=1)]


@dataclass(frozen=True)
class PlannedScenario:
    scenario: str
    fixture_path: Path
    fixture: FixtureInput
    batch: TranscriptBatch


class ExpectedCheckInput(StrictInput):
    passed: bool
    dimensions: dict[Dimension, bool] | None = None
    verdict: Verdict | None = None
    claims: list[NonemptyText] | None = None

    @model_validator(mode="after")
    def validate_dimensions(self) -> Self:
        for field in ("dimensions", "verdict", "claims"):
            if field in self.model_fields_set and getattr(self, field) is None:
                raise ValueError(f"Expected {field} cannot be null")
        if self.dimensions is not None and (
            set(self.dimensions)
            != {"factualSupport", "taskCompleteness", "answerQuality"}
            or self.passed != all(self.dimensions.values())
        ):
            raise ValueError("Invalid expected dimensions")
        return self


class CaseInput(FixtureInput):
    id: NonemptyText
    answer: NonemptyText
    categories: Annotated[list[NonemptyText], Field(min_length=1)]
    checks: Annotated[dict[CheckKind, ExpectedCheckInput], Field(min_length=1)]

    @model_validator(mode="after")
    def validate_checks(self) -> Self:
        for kind, check in self.checks.items():
            if kind != "answer" and check.dimensions is not None:
                raise ValueError("Only answer checks may specify dimensions")
            if kind == "direct" and check.verdict is None:
                raise ValueError("Invalid expected claim verdict")
            if kind == "extraction" and not check.claims:
                raise ValueError("Invalid expected claims")
        return self

    def report_data(self) -> JudgeCase:
        # Validate first, then serialize at the JSON/report boundary. Unset defaults
        # must not add fields to the existing report format.
        return cast(JudgeCase, self.model_dump(exclude_unset=True))


class CollectionInput(StrictInput):
    schemaVersion: Annotated[int, Field(ge=1, le=1)]
    cases: Annotated[list[CaseInput], Field(min_length=1)]

    @field_validator("cases")
    @classmethod
    def unique_cases(cls, cases: list[CaseInput]) -> list[CaseInput]:
        ids: set[str] = set()
        inputs: set[tuple[str, tuple[str, ...], str]] = set()
        for case in cases:
            key = (case.question, tuple(case.references), case.answer)
            if case.id in ids or key in inputs:
                raise ValueError("Duplicate judge case")
            ids.add(case.id)
            inputs.add(key)
        return cases
