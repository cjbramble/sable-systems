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
    review_path = approved_root / gate.V5_REVIEW
    review = json.loads(review_path.read_text())
    review.update(decision='pending', reviewer=None, reviewedAt=None,
                  independentHumanReview=False, reviewedBeforeLiveExposure=False)
    review_path.write_text(json.dumps(review))
    monkeypatch.setattr(evaluation, 'judge_answer', lambda *args: pytest.fail('No calls before approval'))
    output = tmp_path / 'pending.json'
    with pytest.raises(ValueError, match='Independent human review is pending; review reports/deepeval-benchmark-v5-review.md'):
        run(monkeypatch, approved_root, output)
    assert not output.exists()
    assert not output.with_suffix('.jsonl').exists()


def run(monkeypatch, root, output):
    monkeypatch.setattr(evaluation, 'ROOT', root)
    monkeypatch.setattr(sys, 'argv', ['evaluate_support.py', '--output', str(output)])
    monkeypatch.setattr(sys, 'stdin', io.StringIO(json.dumps({'mode': 'validation', 'suite': 'qualification-v5', 'concurrency': 2})))
    return evaluation.main()


@pytest.fixture
def approved_root(tmp_path):
    for name in (*gate.V5_LOCK_FILES, gate.V5_FREEZE, gate.V5_REVIEW, 'tests/fixtures/judge/holdout.json'):
        target = tmp_path / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(gate.frozen_bytes(evaluation.ROOT, name))
    # A fictional current-code freeze only in this temporary directory. Keep
    # the actual benchmark and human review record unchanged.
    fixture_path = tmp_path / gate.V5_FIXTURE
    fixture = json.loads(fixture_path.read_text())
    fixture['gradingRevision'] = gate.GRADING_REVISION
    fixture_path.write_text(json.dumps(fixture))
    freeze_path = tmp_path / gate.V5_FREEZE
    freeze = json.loads(freeze_path.read_text())
    freeze['gradingRevision'] = gate.GRADING_REVISION
    freeze['model'], freeze['generation'] = judge_metadata()
    freeze['sha256'] = {name: gate.digest(tmp_path / name) for name in gate.V5_LOCK_FILES}
    freeze_path.write_text(json.dumps(freeze))
    review_path = tmp_path / gate.V5_REVIEW
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
        name = {'answer': gate.V5_FIXTURE, 'sheet': gate.V5_SHEET, 'code': 'tools/evaluation/support_grading.py'}[change]
        path = approved_root / name
        path.write_text(path.read_text() + '\n')
    elif change == 'review':
        path = approved_root / gate.V5_REVIEW
        review = json.loads(path.read_text())
        review['freezeSha256'] = '0' * 64
        path.write_text(json.dumps(review))
    elif change == 'model':
        model = {**model, 'alias': 'different-model'}
    elif change == 'generation':
        generation = {**generation, 'max_tokens': 8192}
    elif change in ('retry', 'budget', 'revision'):
        path = approved_root / gate.V5_FREEZE
        freeze = json.loads(path.read_text())
        if change == 'retry':
            freeze['retryPolicy']['maxRetries'] = 4
        elif change == 'budget':
            freeze['qualificationPolicy']['maxModelCallsPerRun'] = 40
        else:
            freeze['gradingRevision'] = 13
        path.write_text(json.dumps(freeze))
    with pytest.raises(ValueError):
        gate.validate_qualification(approved_root, model, generation, 1 if change == 'workers' else 2, version=5)


def test_approved_benchmark_routes_only_unlabeled_inputs_and_keeps_all_results(monkeypatch, approved_root, tmp_path):
    fixture = json.loads((approved_root / gate.V5_FIXTURE).read_text())
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
    assert report['suite'] == 'qualification-v5'
    assert report['policy']['gradingRevision'] == gate.GRADING_REVISION
    assert report['benchmarkFreeze']['manifest']['retryPolicy'] == RETRY_POLICY
    assert report['coverage']['expectedSamples'] == report['coverage']['processedSamples'] == 40
    assert report['summary']['overall']['labelDisagreements'] == 0
    assert report['labelAgreementSuccessful'] is True


def test_new_cases_are_distinct_from_previous_answers_and_consistently_labeled():
    root = evaluation.ROOT
    fixture = json.loads((root / gate.V5_FIXTURE).read_text())
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
        if path in (root / gate.V5_FIXTURE, root / 'tests/fixtures/judge/archive/record-access-controls-v2.json',
                    root / 'tests/fixtures/judge/archive/output-budget-controls-v1.json'):
            continue
        scenarios = json.loads(path.read_text()).get('scenarios', [])
        if isinstance(scenarios, list):
            previous.update(r['text'] for s in scenarios for r in s.get('examples', []) if 'text' in r)
    assert not previous.intersection(r['text'] for r in answers)




def test_current_review_record_matches_frozen_candidate():
    root = evaluation.ROOT
    review = json.loads((root / gate.V5_REVIEW).read_text())
    freeze = json.loads((root / gate.V5_FREEZE).read_text())
    assert review['fixtureSha256'] == gate.digest(root / gate.V5_FIXTURE)
    assert review['freezeSha256'] == gate.digest(root / gate.V5_FREEZE)
    assert freeze['gradingRevision'] == 15
    assert freeze['retryPolicy'] == RETRY_POLICY
    # The source and reasoning settings changed after this completed benchmark.
    # Historical human approval must not authorize the changed adapter.
    with pytest.raises(ValueError, match='Qualification freeze mismatch'):
        gate.validate_qualification(root, *judge_metadata(), 2, version=5)
