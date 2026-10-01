"""Fresh-benchmark gates and report contracts; all judge responses are scripted."""

import io
import json
import shutil
import sys

import pytest

import benchmark_review as gate
import evaluate_support as evaluation
from openrouter_judge import judge_metadata


@pytest.fixture
def candidate_root(tmp_path):
    for name in (*gate.V2_LOCK_FILES, gate.V2_FREEZE, gate.V2_REVIEW,
                 gate.REVIEW, 'tests/fixtures/judge/holdout.json'):
        path = tmp_path / name
        path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(evaluation.ROOT / name, path)
    # Exercise a pending review even after a real human approval is recorded.
    path = tmp_path / gate.V2_REVIEW
    review = json.loads(path.read_text())
    review.update(decision='pending', reviewer=None, reviewedAt=None,
                  independentHumanReview=False, reviewedBeforeLiveExposure=False)
    path.write_text(json.dumps(review))
    return tmp_path


def approve_scripted_review(root):
    path = root / gate.V2_REVIEW
    review = json.loads(path.read_text())
    review.update(decision='approved', reviewer='Fictional offline reviewer',
                  reviewedAt='2026-10-01T00:00:00+00:00',
                  independentHumanReview=True, reviewedBeforeLiveExposure=True)
    path.write_text(json.dumps(review))
    return review


def validate(root, concurrency=2):
    return gate.validate_qualification(root, *judge_metadata(), concurrency, version=2)


def run(monkeypatch, root, output):
    monkeypatch.setattr(evaluation, 'ROOT', root)
    monkeypatch.setattr(sys, 'argv', ['evaluate_support.py', '--output', str(output)])
    monkeypatch.setattr(sys, 'stdin', io.StringIO(json.dumps(
        {'mode': 'validation', 'suite': 'qualification-v2', 'concurrency': 2})))
    return evaluation.main()


def test_pending_v2_review_blocks_calls_and_artifacts(monkeypatch, candidate_root, tmp_path):
    monkeypatch.setattr(evaluation, 'judge_answer', lambda *args: pytest.fail('No live calls'))
    output = tmp_path / 'unapproved.json'
    with pytest.raises(ValueError, match='review docs/deepeval-benchmark-v2-review.md'):
        run(monkeypatch, candidate_root, output)
    assert not output.exists()
    assert not output.with_suffix('.jsonl').exists()


def test_v1_approval_cannot_authorize_v2(candidate_root):
    shutil.copyfile(candidate_root / gate.REVIEW, candidate_root / gate.V2_REVIEW)
    with pytest.raises(ValueError, match='does not match the frozen fixture'):
        validate(candidate_root)


@pytest.mark.parametrize('name', [gate.V2_FIXTURE, gate.V2_SHEET,
                                  'tools/evaluation/support_grading.py'])
def test_v2_approval_cannot_authorize_modified_inputs(candidate_root, name):
    approve_scripted_review(candidate_root)
    path = candidate_root / name
    path.write_text(path.read_text() + '\n')
    with pytest.raises(ValueError, match='Qualification freeze mismatch'):
        validate(candidate_root)


def test_v2_plan_requires_two_workers(candidate_root):
    approve_scripted_review(candidate_root)
    with pytest.raises(ValueError, match='frozen concurrency of 2'):
        validate(candidate_root, concurrency=4)


@pytest.mark.parametrize('fault', ['none', 'false-accept', 'false-reject', 'dimension', 'upstream'])
def test_v2_withholds_labels_and_separates_failures(monkeypatch, candidate_root, tmp_path, fault):
    approval = approve_scripted_review(candidate_root)
    fixture = json.loads((candidate_root / gate.V2_FIXTURE).read_text())
    expected = {(s['question'], r['text'], s['reference']): r
                for s in fixture['scenarios'] for r in s['examples']}
    calls = []
    target = fixture['scenarios'][0]['examples'][0 if fault == 'false-reject' else 1]['text']

    def scripted(question, answer, reference):
        calls.append((question, answer, reference))
        row = expected[(question, answer, reference)]
        dims = dict(row['expectedDimensions'])
        passed = row['correct']
        if answer == target:
            if fault == 'upstream':
                raise RuntimeError('Scripted upstream 429; not live evidence')
            if fault == 'false-accept':
                dims = dict.fromkeys(dims, True)
                passed = True
            if fault == 'false-reject':
                dims['factualSupport'] = False
                passed = False
            if fault == 'dimension':
                dims['answerQuality'] = False
        return {'passed': passed, 'score': int(passed), 'dimensions': dims,
                'reason': 'Scripted contract test, not model evidence', 'calls': []}

    monkeypatch.setattr(evaluation, 'judge_answer', scripted)
    output = tmp_path / 'scripted.json'
    assert run(monkeypatch, candidate_root, output) == int(fault != 'none')
    report = json.loads(output.read_text())
    assert sorted(calls) == sorted(expected)
    assert report['coverage']['expectedSamples'] == report['coverage']['processedSamples'] == 40
    assert len(report['coverage']['processedScenarios']) == 20
    assert report['benchmarkFreeze']['independentReview'] == approval
    assert report['suite'] == 'qualification-v2'
    assert report['concurrency'] == 2
    assert report['policy']['gradingRevision'] == 12
    assert report['policy']['mode'] == 'advisory'
    summary = report['summary']['overall']
    assert summary['executionErrors'] == int(fault == 'upstream')
    assert summary['falseAcceptances'] == int(fault == 'false-accept')
    assert summary['falseRejections'] == int(fault == 'false-reject')
    assert summary['dimensionDisagreements']['answerQuality'] == int(fault == 'dimension')
    assert report['executionSuccessful'] == (fault != 'upstream')
    assert report['labelAgreementSuccessful'] == (fault == 'none')


def test_fresh_cases_are_balanced_and_not_copied_from_exposed_answers():
    root = evaluation.ROOT
    fixture = json.loads((root / gate.V2_FIXTURE).read_text())
    rows = [r for s in fixture['scenarios'] for r in s['examples']]
    assert len(fixture['scenarios']) == 20
    assert len(rows) == 40
    assert sum(r['correct'] for r in rows) == 20
    assert all(r['correct'] == all(r['expectedDimensions'].values()) for r in rows)
    exposed = set()
    for name in ('qualification-v1.json', 'quality-controls-v1.json'):
        old = json.loads((root / 'tests/fixtures/judge' / name).read_text())
        exposed.update(r['text'] for s in old['scenarios'] for r in s['examples'])
    assert not exposed.intersection(r['text'] for r in rows)
    freeze = json.loads((root / gate.V2_FREEZE).read_text())
    review = json.loads((root / gate.V2_REVIEW).read_text())
    assert freeze['gradingRevision'] == fixture['gradingRevision'] == 12
    assert freeze['qualificationPolicy'] == gate.V2_POLICY
    assert review['fixtureSha256'] == gate.digest(root / gate.V2_FIXTURE)
    assert review['freezeSha256'] == gate.digest(root / gate.V2_FREEZE)
    assert all(gate.digest(root / name) == sha for name, sha in freeze['sha256'].items())
    if review['decision'] == 'pending':
        assert review['reviewer'] is None
        assert review['independentHumanReview'] is False
    else:
        validate(root)
