"""Shared types for the existing JSON reports and request evidence."""

from typing import Literal, NotRequired, TypedDict

type CheckKind = Literal["answer", "direct", "extraction"]
type Status = Literal["passed", "failed", "error", "pending"]
type Verdict = Literal["yes", "no", "idk"]
type Dimension = Literal["factualSupport", "taskCompleteness", "answerQuality"]
type Dimensions = dict[Dimension, bool]


class RequestRecord(TypedDict, total=False):
    request: dict[str, object]
    logicalRequest: int
    attempt: int
    httpStatus: int
    responseBytes: int
    responseComplete: bool
    rawResponse: str
    response: object
    completed: bool
    errorType: str
    retryReason: str
    retryExhausted: bool
    retrySkipped: str
    retryDelaySeconds: float


class RequestEvidence(TypedDict, total=False):
    calls: list[RequestRecord]


class RequestSummary(TypedDict):
    requestAttempts: int
    retryAttempts: int
    rateLimitedAttempts: int
    recoveredRateLimitedRequests: int
    unresolvedRateLimitedRequests: int
    incompleteResponseAttempts: int
    recoveredIncompleteResponseRequests: int
    unresolvedIncompleteResponseRequests: int


class ClaimMatch(TypedDict):
    claim: str
    extractedIndices: list[int]


class ClaimCoverage(TypedDict):
    passed: bool
    matches: list[ClaimMatch]
    missingClaims: list[str]
    nonSourceQuotes: list[str]
    unmatchedClaims: list[str]


class VerdictRecord(TypedDict):
    verdict: Verdict
    reason: str | None


class JudgeResult(RequestEvidence, total=False):
    score: int
    passed: bool
    reason: str | None
    dimensions: Dimensions
    assessment: dict[str, object]
    reference: str
    claims: list[str]
    verdicts: list[VerdictRecord]
    claimCoverage: ClaimCoverage


class ExpectedCheck(TypedDict):
    passed: bool
    dimensions: NotRequired[Dimensions]
    verdict: NotRequired[Verdict]
    claims: NotRequired[list[str]]


class JudgeCase(TypedDict):
    id: str
    question: str
    answer: str
    references: list[str]
    categories: list[str]
    checks: dict[CheckKind, ExpectedCheck]


class CheckResult(TypedDict):
    kind: CheckKind
    expected: ExpectedCheck
    status: Status
    actual: NotRequired[JudgeResult]
    error: NotRequired[str]
    seconds: NotRequired[float]


class CaseResult(TypedDict):
    id: str
    checks: list[CheckResult]
    seconds: float


class CollectionSummary(TypedDict):
    cases: dict[Status, int]
    checks: dict[Status, int]
    byCategory: dict[str, dict[Status, int]]


class ModelMetadata(TypedDict):
    provider: str
    alias: str


class ReasoningSettings(TypedDict):
    enabled: bool
    effort: NotRequired[str]


class GenerationSettings(TypedDict):
    temperature: int
    top_p: int
    max_tokens: int
    stream: bool
    reasoning: NotRequired[ReasoningSettings]
    provider: NotRequired[dict[str, object]]


class RetryPolicy(TypedDict):
    httpStatuses: list[int]
    transportErrors: list[str]
    transportHttpStatuses: list[int]
    maxRetries: int
    backoffSeconds: list[int]
    jitterSeconds: float
    maxDelaySeconds: float
    honorRetryAfter: bool


class CollectionMetadata(TypedDict):
    model: ModelMetadata
    generation: GenerationSettings
    gradingRevision: int
    retryPolicy: RetryPolicy
    concurrency: int
    collectionSha256: str
    sourceSha256: dict[str, str]


class CollectionReport(TypedDict):
    schemaVersion: int
    mode: str
    policy: str
    startedAt: str
    metadata: CollectionMetadata
    cases: list[JudgeCase]
    results: list[CaseResult]
    finishedAt: NotRequired[str]
    requests: NotRequired[RequestSummary]
    summary: NotRequired[CollectionSummary]
    successful: NotRequired[bool]


class TranscriptResult(JudgeResult):
    scenario: str
    id: int
    answer: str | None
    sourceRequest: object
    fixtureSha256: str
    factualPassed: bool
    failure: dict[str, object] | None
    executionPhase: NotRequired[Literal["generator", "judge"]]
    error: NotRequired[str]
    seconds: NotRequired[float]
    judgeApplicationAgrees: NotRequired[bool]


class TranscriptSummary(RequestSummary):
    samples: int
    executionErrors: int
    applicationFailures: int
    judgeApplicationDisagreements: int
    generatorExecutionErrors: int
    judgeExecutionErrors: int
    factualFailures: int
    judgeRejections: int


class TranscriptSummaries(TypedDict):
    overall: TranscriptSummary
    byScenario: dict[str, TranscriptSummary]


class TranscriptCoverage(TypedDict):
    expectedScenarios: list[str]
    expectedSamples: int
    processedScenarios: NotRequired[list[str]]
    processedSamples: NotRequired[int]


class TranscriptPolicy(TypedDict):
    mode: str
    metric: str
    strictMode: bool
    gradingRevision: int
    assessmentRules: str


class TranscriptReport(TypedDict):
    schemaVersion: int
    mode: str
    model: ModelMetadata
    concurrency: int
    deepevalVersion: str
    policy: TranscriptPolicy
    generation: GenerationSettings
    retryPolicy: RetryPolicy
    evaluatorSha256: dict[str, str]
    sourceTranscript: str | None
    sourceSha256: str | None
    coverage: TranscriptCoverage
    results: list[TranscriptResult]
    summary: NotRequired[TranscriptSummaries]
    executionSuccessful: NotRequired[bool]
    judgeApplicationAgreementSuccessful: NotRequired[bool]
    factualSuccessful: NotRequired[bool]
    successful: NotRequired[bool]
