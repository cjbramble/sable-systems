"""Verify the review and freeze for the current structured judge benchmark."""

from datetime import datetime
import hashlib
import json


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


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def validate_qualification(root, model, generation, concurrency, *, version=1):
    if version not in (1, 2):
        raise ValueError('Unknown qualification version')
    fixture_name, freeze_name, review_name, sheet_name, lock_files, expected_policy = (
        (FIXTURE, FREEZE, REVIEW, SHEET, LOCK_FILES, QUALIFICATION_POLICY) if version == 1 else
        (V2_FIXTURE, V2_FREEZE, V2_REVIEW, V2_SHEET, V2_LOCK_FILES, V2_POLICY))
    if concurrency != expected_policy['concurrency']:
        raise ValueError(f"The reviewed benchmark requires its frozen concurrency of {expected_policy['concurrency']}")
    freeze_path = root / freeze_name
    freeze = json.loads(freeze_path.read_text())
    if freeze.get('schemaVersion') != 1 or set(freeze.get('sha256', {})) != set(lock_files):
        raise ValueError('Invalid qualification freeze file list')
    for name, expected in freeze['sha256'].items():
        if digest(root / name) != expected:
            raise ValueError(f'Qualification freeze mismatch: {name}')
    if freeze.get('model') != model or freeze.get('generation') != generation:
        raise ValueError('Qualification model or generation settings differ from the freeze')
    fixture = json.loads((root / fixture_name).read_text())
    examples = [row for scenario in fixture['scenarios'] for row in scenario['examples']]
    for row in examples:
        dims = row.get('expectedDimensions', {})
        if set(dims) != set(DIMENSIONS) or any(type(value) is not bool for value in dims.values()) or row.get('correct') is not all(dims.values()):
            raise ValueError('Qualification requires consistent labels for all three dimensions')
    policy = freeze.get('qualificationPolicy', {})
    if policy != expected_policy or len(examples) != policy['maxModelCallsPerRun']:
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
