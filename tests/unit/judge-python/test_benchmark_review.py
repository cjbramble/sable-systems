import copy
import io
import json
import shutil
import sys

import pytest

import benchmark_review as review_gate
import evaluate_support as evaluation
from openrouter_judge import judge_metadata


@pytest.fixture
def frozen_root(tmp_path):
    for name in (*review_gate.LOCK_FILES, review_gate.FREEZE, review_gate.REVIEW,
                 'tests/fixtures/judge/holdout.json'):
        destination = tmp_path / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(review_gate.resolve_frozen_path(evaluation.ROOT, name), destination)
    # Build a fictional current-code freeze only in the temporary test root.
    # The approved production revision-8 freeze remains unchanged after tuning.
    freeze_path = tmp_path / review_gate.FREEZE
    freeze = json.loads(freeze_path.read_text())
    freeze['gradingRevision'] = 14
    freeze['model'], freeze['generation'] = judge_metadata()
    freeze['sha256'] = {name: review_gate.digest(tmp_path / name) for name in review_gate.LOCK_FILES}
    freeze_path.write_text(json.dumps(freeze))
    path = tmp_path / review_gate.REVIEW
    review = json.loads(path.read_text())
    review.update(decision='pending', reviewer=None, reviewedAt=None,
                  independentHumanReview=False, reviewedBeforeLiveExposure=False,
                  freezeSha256=review_gate.digest(freeze_path))
    path.write_text(json.dumps(review))
    return tmp_path


def approve_for_offline_test(root):
    path = root / review_gate.REVIEW
    review = json.loads(path.read_text())
    review.update(decision='approved', reviewer='Offline Test Reviewer',
                  reviewedAt='2026-09-30T12:00:00+00:00', independentHumanReview=True,
                  reviewedBeforeLiveExposure=True)
    path.write_text(json.dumps(review))
    return review


def validate(root, concurrency=4, model=None, generation=None):
    actual_model, actual_generation = judge_metadata()
    return review_gate.validate_qualification(root, actual_model if model is None else model,
                                            actual_generation if generation is None else generation, concurrency)


def run(monkeypatch, root, output):
    monkeypatch.setattr(evaluation, 'ROOT', root)
    monkeypatch.setattr(sys, 'argv', ['evaluate_support.py', '--output', str(output)])
    monkeypatch.setattr(sys, 'stdin', io.StringIO(json.dumps({'mode': 'validation', 'suite': 'qualification', 'concurrency': 4})))
    return evaluation.main()


def test_pending_review_prevents_any_judgment_or_run_artifact(monkeypatch, frozen_root, tmp_path):
    monkeypatch.setattr(evaluation, 'judge_answer', lambda *args: pytest.fail('No model call before human review'))
    output = tmp_path / 'run.json'
    with pytest.raises(ValueError, match='Independent human review is pending'):
        run(monkeypatch, frozen_root, output)
    assert not output.exists()
    assert not output.with_suffix('.jsonl').exists()


@pytest.mark.parametrize('name', [review_gate.FIXTURE, review_gate.SHEET,
                                  'tools/evaluation/support_grading.py',
                                  'tools/evaluation/evaluate_support.py',
                                  'scripts/test-support-judge.mjs', 'lib/openrouter-config.json'])
def test_review_cannot_authorize_changed_inputs(frozen_root, name):
    approve_for_offline_test(frozen_root)
    path = frozen_root / name
    path.write_text(path.read_text() + '\n')
    with pytest.raises(ValueError, match='Qualification freeze mismatch'):
        validate(frozen_root)


@pytest.mark.parametrize('change', [
    {'reviewer': ''}, {'reviewedAt': 'not-a-date'}, {'reviewedAt': '2026-09-30T12:00:00'},
    {'independentHumanReview': False}, {'reviewedBeforeLiveExposure': False},
    {'fixtureSha256': 'stale-fixture'}, {'freezeSha256': 'stale-freeze'},
])
def test_review_requires_identity_time_attestation_and_matching_hashes(frozen_root, change):
    review = approve_for_offline_test(frozen_root)
    review.update(change)
    (frozen_root / review_gate.REVIEW).write_text(json.dumps(review))
    with pytest.raises(ValueError):
        validate(frozen_root)


@pytest.mark.parametrize('change', ['model', 'reasoning', 'max_tokens', 'provider'])
def test_runtime_overrides_cannot_silently_change_reviewed_configuration(frozen_root, change):
    approve_for_offline_test(frozen_root)
    model, generation = copy.deepcopy(judge_metadata())
    if change == 'model':
        model['alias'] = 'different/model'
    elif change == 'reasoning':
        generation['reasoning']['enabled'] = not generation['reasoning']['enabled']
    elif change == 'max_tokens':
        generation['max_tokens'] += 1
    else:
        generation['provider']['require_parameters'] = not generation['provider']['require_parameters']
    with pytest.raises(ValueError, match='settings differ'):
        validate(frozen_root, model=model, generation=generation)


def test_reviewed_benchmark_rejects_scheduler_drift(frozen_root):
    approve_for_offline_test(frozen_root)
    with pytest.raises(ValueError, match='frozen concurrency'):
        validate(frozen_root, concurrency=1)


@pytest.mark.parametrize('wrong_dimension', [False, True])
def test_reviewed_run_withholds_labels_and_reports_every_dimension(monkeypatch, frozen_root, tmp_path, wrong_dimension):
    approved = approve_for_offline_test(frozen_root)
    fixture = json.loads((frozen_root / review_gate.FIXTURE).read_text())
    expected = [(scenario['question'], row['text'], scenario['reference'])
                for scenario in fixture['scenarios'] for row in scenario['examples']]
    labels = {(scenario['question'], row['text']): row
              for scenario in fixture['scenarios'] for row in scenario['examples']}
    calls = []
    def judge(question, answer, reference):
        calls.append((question, answer, reference))
        row = labels[(question, answer)]
        dims = dict(row['expectedDimensions'])
        if wrong_dimension and answer == 'The Reopening Desk can authorize a replacement.':
            dims['taskCompleteness'] = True
        return {'passed': row['correct'], 'score': int(row['correct']), 'dimensions': dims,
                'reason': 'Offline response, not live qualification evidence', 'calls': []}
    monkeypatch.setattr(evaluation, 'judge_answer', judge)
    output = tmp_path / 'run.json'
    assert run(monkeypatch, frozen_root, output) == int(wrong_dimension)
    report = json.loads(output.read_text())
    assert sorted(calls) == sorted(expected)
    assert report['concurrency'] == 4
    assert [(row['scenario'], row['id']) for row in report['results']] == [
        (scenario['id'], row['id']) for scenario in fixture['scenarios'] for row in scenario['examples']]
    assert report['coverage']['expectedSamples'] == report['coverage']['processedSamples'] == 32
    assert len(report['coverage']['processedScenarios']) == 16
    assert report['benchmarkFreeze']['independentReview'] == approved
    assert report['policy']['gradingRevision'] == 14
    assert report['summary']['overall']['falseAcceptances'] == report['summary']['overall']['falseRejections'] == 0
    assert report['summary']['overall']['dimensionDisagreements']['taskCompleteness'] == int(wrong_dimension)
    assert report['policy']['mode'] == 'advisory'


def test_real_candidate_has_balanced_labels_and_a_matching_review_record():
    root = evaluation.ROOT
    review = json.loads((root / review_gate.REVIEW).read_text())
    assert review['decision'] in ('pending', 'approved')
    if review['decision'] == 'pending':
        assert review['reviewer'] is None
        assert review['independentHumanReview'] is False
    else:
        # Prior approval must not authorize the corrected evaluator on exposed cases.
        with pytest.raises(ValueError, match='Qualification freeze mismatch'):
            validate(root)
    fixture = json.loads((root / review_gate.FIXTURE).read_text())
    rows = [row for scenario in fixture['scenarios'] for row in scenario['examples']]
    assert len(fixture['scenarios']) == 16
    assert len(rows) == 32
    assert sum(row['correct'] for row in rows) == 16
    assert all(row['correct'] == all(row['expectedDimensions'].values()) for row in rows)
    assert review['fixtureSha256'] == review_gate.digest(root / review_gate.FIXTURE)
    assert review['freezeSha256'] == review_gate.digest(root / review_gate.FREEZE)


def update_test_freeze_and_review(root, freeze):
    path = root / review_gate.FREEZE
    path.write_text(json.dumps(freeze))
    review = approve_for_offline_test(root)
    review.update(freezeSha256=review_gate.digest(path), fixtureSha256=freeze['sha256'][review_gate.FIXTURE])
    (root / review_gate.REVIEW).write_text(json.dumps(review))


@pytest.mark.parametrize('change', ['missing-dimension', 'overall-disagreement'])
def test_even_matching_review_cannot_authorize_incoherent_labels(frozen_root, change):
    path = frozen_root / review_gate.FIXTURE
    fixture = json.loads(path.read_text())
    row = fixture['scenarios'][0]['examples'][0]
    if change == 'missing-dimension':
        row['expectedDimensions'].pop('answerQuality')
    else:
        row['correct'] = False
    path.write_text(json.dumps(fixture))
    freeze = json.loads((frozen_root / review_gate.FREEZE).read_text())
    freeze['sha256'][review_gate.FIXTURE] = review_gate.digest(path)
    update_test_freeze_and_review(frozen_root, freeze)
    with pytest.raises(ValueError, match='consistent labels'):
        validate(frozen_root)


@pytest.mark.parametrize('key,value', [('plannedRuns', 4), ('maxFalseAcceptances', 1)])
def test_even_matching_review_cannot_silently_relax_the_call_or_success_plan(frozen_root, key, value):
    freeze = json.loads((frozen_root / review_gate.FREEZE).read_text())
    freeze['qualificationPolicy'][key] = value
    update_test_freeze_and_review(frozen_root, freeze)
    with pytest.raises(ValueError, match='Invalid qualification call plan'):
        validate(frozen_root)
