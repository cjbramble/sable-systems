"""Verify the review and freeze for the current structured judge benchmark."""

from datetime import datetime
import hashlib
import json

from openrouter_judge import RETRY_POLICY
from support_grading import GRADING_REVISION


FIXTURE = 'tests/fixtures/judge/qualification-v1.json'
FREEZE = 'tests/fixtures/judge/qualification-freeze.json'
REVIEW = 'tests/fixtures/judge/qualification-review.json'
SHEET = 'docs/deepeval-benchmark-review.md'
LOCK_FILES = (FIXTURE, SHEET, 'tools/evaluation/benchmark_review.py',
              'tools/evaluation/evaluate_support.py', 'tools/evaluation/support_grading.py',
              'tools/evaluation/openrouter_judge.py', 'tools/evaluation/uv.lock',
              'lib/openrouter-config.json', 'scripts/test-support-judge.mjs')
DIMENSIONS = ('factualSupport', 'taskCompleteness', 'answerQuality')
QUALIFICATION_POLICY = {'plannedRuns': 3, 'concurrency': 4, 'maxModelCallsPerRun': 32,
                        'maxFalseAcceptances': 0, 'maxFalseRejections': 0,
                        'maxDimensionDisagreements': 0, 'maxExecutionErrors': 0,
                        'humanExplanationReviewRequired': True}
V2_FIXTURE = 'tests/fixtures/judge/qualification-v2.json'
V2_FREEZE = 'tests/fixtures/judge/qualification-v2-freeze.json'
V2_REVIEW = 'tests/fixtures/judge/qualification-v2-review.json'
V2_SHEET = 'docs/deepeval-benchmark-v2-review.md'
V2_LOCK_FILES = (V2_FIXTURE, V2_SHEET, *LOCK_FILES[2:])
V2_POLICY = {**QUALIFICATION_POLICY, 'concurrency': 2, 'maxModelCallsPerRun': 40}
V3_FIXTURE = 'tests/fixtures/judge/qualification-v3.json'
V3_FREEZE = 'tests/fixtures/judge/qualification-v3-freeze.json'
V3_REVIEW = 'tests/fixtures/judge/qualification-v3-review.json'
V3_SHEET = 'docs/deepeval-benchmark-v3-review.md'
V3_LOCK_FILES = (V3_FIXTURE, V3_SHEET, *LOCK_FILES[2:], 'tools/evaluation/evaluate.py')
V3_POLICY = {**V2_POLICY, 'maxLogicalRequestsPerRun': 40, 'maxModelCallsPerRun': 160}
V4_FIXTURE = 'tests/fixtures/judge/qualification-v4.json'
V4_FREEZE = 'tests/fixtures/judge/qualification-v4-freeze.json'
V4_REVIEW = 'tests/fixtures/judge/qualification-v4-review.json'
V4_SHEET = 'reports/deepeval-benchmark-v4-review.md'
V4_LOCK_FILES = (V4_FIXTURE, V4_SHEET, *LOCK_FILES[2:], 'tools/evaluation/evaluate.py')
V4_POLICY = dict(V3_POLICY)
V5_FIXTURE = 'tests/fixtures/judge/qualification-v5.json'
V5_FREEZE = 'tests/fixtures/judge/qualification-v5-freeze.json'
V5_REVIEW = 'tests/fixtures/judge/qualification-v5-review.json'
V5_SHEET = 'reports/deepeval-benchmark-v5-review.md'
V5_LOCK_FILES = (V5_FIXTURE, V5_SHEET, *LOCK_FILES[2:], 'tools/evaluation/evaluate.py')
V5_POLICY = dict(V3_POLICY)


def resolve_frozen_path(root, name):
    """Keep original freeze keys while locating moved, unchanged review sheets."""
    original = root / name
    relocated = {SHEET: 'reports/deepeval-benchmark-review.md',
                 V2_SHEET: 'reports/deepeval-benchmark-v2-review.md',
                 V3_SHEET: 'reports/deepeval-benchmark-v3-review.md'}
    if not original.exists() and name in relocated:
        return root / relocated[name]
    return original


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def validate_qualification(root, model, generation, concurrency, *, version=1):
    if version not in (1, 2, 3, 4, 5):
        raise ValueError('Unknown qualification version')
    fixture_name, freeze_name, review_name, sheet_name, lock_files, expected_policy = (
        (FIXTURE, FREEZE, REVIEW, SHEET, LOCK_FILES, QUALIFICATION_POLICY) if version == 1 else
        (V2_FIXTURE, V2_FREEZE, V2_REVIEW, V2_SHEET, V2_LOCK_FILES, V2_POLICY) if version == 2 else
        (V3_FIXTURE, V3_FREEZE, V3_REVIEW, V3_SHEET, V3_LOCK_FILES, V3_POLICY) if version == 3 else
        (V4_FIXTURE, V4_FREEZE, V4_REVIEW, V4_SHEET, V4_LOCK_FILES, V4_POLICY) if version == 4 else
        (V5_FIXTURE, V5_FREEZE, V5_REVIEW, V5_SHEET, V5_LOCK_FILES, V5_POLICY))
    if concurrency != expected_policy['concurrency']:
        raise ValueError(f"The reviewed benchmark requires its frozen concurrency of {expected_policy['concurrency']}")
    freeze_path = root / freeze_name
    freeze = json.loads(freeze_path.read_text())
    if freeze.get('schemaVersion') != 1 or set(freeze.get('sha256', {})) != set(lock_files):
        raise ValueError('Invalid qualification freeze file list')
    for name, expected in freeze['sha256'].items():
        if digest(resolve_frozen_path(root, name)) != expected:
            raise ValueError(f'Qualification freeze mismatch: {name}')
    if freeze.get('model') != model or freeze.get('generation') != generation:
        raise ValueError('Qualification model or generation settings differ from the freeze')
    if version >= 3 and freeze.get('retryPolicy') != RETRY_POLICY:
        raise ValueError('Qualification retry settings differ from the freeze')
    fixture = json.loads((root / fixture_name).read_text())
    if version >= 3 and (freeze.get('gradingRevision') != GRADING_REVISION or fixture.get('gradingRevision') != GRADING_REVISION):
        raise ValueError(f'Qualification requires grading revision {GRADING_REVISION}')
    examples = [row for scenario in fixture['scenarios'] for row in scenario['examples']]
    for row in examples:
        dims = row.get('expectedDimensions', {})
        if set(dims) != set(DIMENSIONS) or any(type(value) is not bool for value in dims.values()) or row.get('correct') is not all(dims.values()):
            raise ValueError('Qualification requires consistent labels for all three dimensions')
    policy = freeze.get('qualificationPolicy', {})
    logical_budget = policy.get('maxLogicalRequestsPerRun', policy.get('maxModelCallsPerRun'))
    if policy != expected_policy or len(examples) != logical_budget:
        raise ValueError('Invalid qualification call plan')
    review = json.loads((root / review_name).read_text())
    if review.get('schemaVersion') != 1:
        raise ValueError('Invalid qualification review schema')
    if review.get('decision') != 'approved' or review.get('independentHumanReview') is not True or review.get('reviewedBeforeLiveExposure') is not True:
        raise ValueError(f'Independent human review is pending; review {sheet_name} before running qualification')
    if not isinstance(review.get('reviewer'), str) or not review['reviewer'].strip():
        raise ValueError('Qualification review requires reviewer identity')
    try:
        reviewed_at = datetime.fromisoformat(review['reviewedAt'])
    except (KeyError, TypeError, ValueError) as error:
        raise ValueError('Qualification review requires an ISO timestamp') from error
    if reviewed_at.tzinfo is None:
        raise ValueError('Qualification review timestamp requires a timezone')
    if review.get('fixtureSha256') != freeze['sha256'][fixture_name] or review.get('freezeSha256') != digest(freeze_path):
        raise ValueError('Qualification review does not match the frozen fixture and evaluator')
    return {'manifest': freeze, 'manifestSha256': digest(freeze_path), 'independentReview': review}
