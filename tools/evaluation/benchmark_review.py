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


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def validate_qualification(root, model, generation, concurrency):
    if concurrency != QUALIFICATION_POLICY['concurrency']:
        raise ValueError('The reviewed benchmark requires its frozen concurrency of 4')
    freeze_path = root / FREEZE
    freeze = json.loads(freeze_path.read_text())
    if freeze.get('schemaVersion') != 1 or set(freeze.get('sha256', {})) != set(LOCK_FILES):
        raise ValueError('Invalid qualification freeze file list')
    for name, expected in freeze['sha256'].items():
        if digest(root / name) != expected:
            raise ValueError(f'Qualification freeze mismatch: {name}')
    if freeze.get('model') != model or freeze.get('generation') != generation:
        raise ValueError('Qualification model or generation settings differ from the freeze')
    fixture = json.loads((root / FIXTURE).read_text())
    examples = [row for scenario in fixture['scenarios'] for row in scenario['examples']]
    for row in examples:
        dims = row.get('expectedDimensions', {})
        if set(dims) != set(DIMENSIONS) or any(type(value) is not bool for value in dims.values()) or row.get('correct') is not all(dims.values()):
            raise ValueError('Qualification requires consistent labels for all three dimensions')
    policy = freeze.get('qualificationPolicy', {})
    if policy != QUALIFICATION_POLICY or len(examples) != policy['maxModelCallsPerRun']:
        raise ValueError('Invalid qualification call plan')
    review = json.loads((root / REVIEW).read_text())
    if review.get('schemaVersion') != 1:
        raise ValueError('Invalid qualification review schema')
    if review.get('decision') != 'approved' or review.get('independentHumanReview') is not True or review.get('reviewedBeforeLiveExposure') is not True:
        raise ValueError('Independent human review is pending; review docs/deepeval-benchmark-review.md before running qualification')
    if not isinstance(review.get('reviewer'), str) or not review['reviewer'].strip():
        raise ValueError('Qualification review requires reviewer identity')
    try:
        reviewed_at = datetime.fromisoformat(review['reviewedAt'])
    except (KeyError, TypeError, ValueError) as error:
        raise ValueError('Qualification review requires an ISO timestamp') from error
    if reviewed_at.tzinfo is None:
        raise ValueError('Qualification review timestamp requires a timezone')
    if review.get('fixtureSha256') != freeze['sha256'][FIXTURE] or review.get('freezeSha256') != digest(freeze_path):
        raise ValueError('Qualification review does not match the frozen fixture and evaluator')
    return {'manifest': freeze, 'manifestSha256': digest(freeze_path), 'independentReview': review}
