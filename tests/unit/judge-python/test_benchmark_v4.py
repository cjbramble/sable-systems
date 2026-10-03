"""Current benchmark approval must precede calls and match frozen inputs."""

import io
import json
import shutil
import sys

import pytest

import benchmark_review as gate
import evaluate_support as evaluation
from openrouter_judge import judge_metadata, RETRY_POLICY


@pytest.fixture(autouse=True)
def settings(monkeypatch):
    monkeypatch.setenv('OPENROUTER_JUDGE_MAX_TOKENS', '16384')
    monkeypatch.setenv('OPENROUTER_JUDGE_REASONING', 'true')
    monkeypatch.setenv('OPENROUTER_JUDGE_MODEL', 'z-ai/glm-5.3-flash')


def test_pending_benchmark_blocks_calls_and_artifacts(monkeypatch, approved_root, tmp_path):
    review_path = approved_root / gate.V4_REVIEW
    review = json.loads(review_path.read_text())
    review.update(decision='pending', reviewer=None, reviewedAt=None,
                  independentHumanReview=False, reviewedBeforeLiveExposure=False)
    review_path.write_text(json.dumps(review))
    monkeypatch.setattr(evaluation, 'judge_answer', lambda *args: pytest.fail('No calls before approval'))
    output = tmp_path / 'pending.json'
    with pytest.raises(ValueError, match='Independent human review is pending; review reports/deepeval-benchmark-v4-review.md'):
        run(monkeypatch, approved_root, output)
    assert not output.exists()
    assert not output.with_suffix('.jsonl').exists()


def run(monkeypatch, root, output):
    monkeypatch.setattr(evaluation, 'ROOT', root)
    monkeypatch.setattr(sys, 'argv', ['evaluate_support.py', '--output', str(output)])
    monkeypatch.setattr(sys, 'stdin', io.StringIO(json.dumps({'mode': 'validation', 'suite': 'qualification-v4', 'concurrency': 2})))
    return evaluation.main()


@pytest.fixture
def approved_root(tmp_path):
    for name in (*gate.V4_LOCK_FILES, gate.V4_FREEZE, gate.V4_REVIEW, 'tests/fixtures/judge/holdout.json'):
        target = tmp_path / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(evaluation.ROOT / name, target)
    # A fictional current-code freeze only in this temporary directory. Keep
    # the actual exposed revision-14 benchmark and human approval unchanged.
    fixture_path = tmp_path / gate.V4_FIXTURE
    fixture = json.loads(fixture_path.read_text())
    fixture['gradingRevision'] = gate.GRADING_REVISION
    fixture_path.write_text(json.dumps(fixture))
    freeze_path = tmp_path / gate.V4_FREEZE
    freeze = json.loads(freeze_path.read_text())
    freeze['gradingRevision'] = gate.GRADING_REVISION
    freeze['sha256'] = {name: gate.digest(tmp_path / name) for name in gate.V4_LOCK_FILES}
    freeze_path.write_text(json.dumps(freeze))
    review_path = tmp_path / gate.V4_REVIEW
    review = json.loads(review_path.read_text())
    review.update(decision='approved', reviewer='Fictional offline reviewer',
                  reviewedAt='2026-10-03T00:00:00+00:00', independentHumanReview=True,
                  reviewedBeforeLiveExposure=True, fixtureSha256=gate.digest(fixture_path),
                  freezeSha256=gate.digest(freeze_path))
    review_path.write_text(json.dumps(review))
    return tmp_path


@pytest.mark.parametrize('change', ['answer', 'sheet', 'code', 'retry', 'model', 'generation', 'budget', 'revision', 'review', 'workers'])
def test_changed_inputs_cannot_reuse_approval(approved_root, change):
    model, generation = judge_metadata()
    if change in ('answer', 'sheet', 'code'):
        name = {'answer': gate.V4_FIXTURE, 'sheet': gate.V4_SHEET, 'code': 'tools/evaluation/support_grading.py'}[change]
        path = approved_root / name
        path.write_text(path.read_text() + '\n')
    elif change == 'review':
        path = approved_root / gate.V4_REVIEW
        review = json.loads(path.read_text())
        review['freezeSha256'] = '0' * 64
        path.write_text(json.dumps(review))
    elif change == 'model':
        model = {**model, 'alias': 'different-model'}
    elif change == 'generation':
        generation = {**generation, 'max_tokens': 8192}
    elif change in ('retry', 'budget', 'revision'):
        path = approved_root / gate.V4_FREEZE
        freeze = json.loads(path.read_text())
        if change == 'retry':
            freeze['retryPolicy']['maxRetries'] = 4
        elif change == 'budget':
            freeze['qualificationPolicy']['maxModelCallsPerRun'] = 40
        else:
            freeze['gradingRevision'] = 13
        path.write_text(json.dumps(freeze))
    with pytest.raises(ValueError):
        gate.validate_qualification(approved_root, model, generation, 1 if change == 'workers' else 2, version=4)


def test_approved_benchmark_routes_only_unlabeled_inputs_and_keeps_all_results(monkeypatch, approved_root, tmp_path):
    fixture = json.loads((approved_root / gate.V4_FIXTURE).read_text())
    expected = {(s['question'], r['text'], s['reference']): r for s in fixture['scenarios'] for r in s['examples']}
    seen = []

    def scripted(question, answer, reference):
        seen.append((question, answer, reference))
        row = expected[(question, answer, reference)]
        return {'passed': row['correct'], 'dimensions': row['expectedDimensions'],
                'calls': [{'logicalRequest': 1, 'attempt': 1, 'httpStatus': 200, 'completed': True}]}

    monkeypatch.setattr(evaluation, 'judge_answer', scripted)
    output = tmp_path / 'approved.json'
    assert run(monkeypatch, approved_root, output) == 0
    report = json.loads(output.read_text())
    assert sorted(seen) == sorted(expected)
    assert len(seen) == len(report['results']) == 40
    assert report['suite'] == 'qualification-v4'
    assert report['policy']['gradingRevision'] == gate.GRADING_REVISION
    assert report['benchmarkFreeze']['manifest']['retryPolicy'] == RETRY_POLICY
    assert report['coverage']['expectedSamples'] == report['coverage']['processedSamples'] == 40
    assert report['summary']['overall']['labelDisagreements'] == 0
    assert report['labelAgreementSuccessful'] is True


def test_new_cases_are_distinct_from_previous_answers_and_consistently_labeled():
    root = evaluation.ROOT
    fixture = json.loads((root / gate.V4_FIXTURE).read_text())
    answers = [r for s in fixture['scenarios'] for r in s['examples']]
    assert len(fixture['scenarios']) == 20
    assert len(answers) == 40
    assert sum(r['correct'] for r in answers) == 20
    assert len({r['text'] for r in answers}) == 40
    assert all(set(r['expectedDimensions']) == set(gate.DIMENSIONS)
               and all(type(v) is bool for v in r['expectedDimensions'].values())
               and r['correct'] is all(r['expectedDimensions'].values()) for r in answers)
    previous = set()
    for path in (root / 'tests/fixtures/judge').glob('*.json'):
        # Later exposed correction controls intentionally reuse failed cases.
        if path in (root / gate.V4_FIXTURE, root / 'tests/fixtures/judge/record-access-controls-v2.json'):
            continue
        scenarios = json.loads(path.read_text()).get('scenarios', [])
        if isinstance(scenarios, list):
            previous.update(r['text'] for s in scenarios for r in s.get('examples', []) if 'text' in r)
    assert not previous.intersection(r['text'] for r in answers)


def test_revision14_approval_cannot_authorize_corrected_judge():
    with pytest.raises(ValueError, match='Qualification freeze mismatch'):
        gate.validate_qualification(evaluation.ROOT, *judge_metadata(), 2, version=4)
