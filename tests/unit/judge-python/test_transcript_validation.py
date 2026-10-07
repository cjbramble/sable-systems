"""Reject unusable transcripts before requests and retain execution evidence."""

import io
import json
import sys

import pytest

import evaluate_support as evaluation


def run_transcript(monkeypatch, output, payload):
    monkeypatch.setattr(sys, 'argv', ['evaluate_support.py', '--output', str(output)])
    monkeypatch.setattr(sys, 'stdin', io.StringIO(json.dumps(payload)))
    return evaluation.main()


@pytest.fixture
def payload():
    return {'mode': 'transcript', 'batches': {'case-pack': {'samples': [
        {'sample': 1, 'answer': '48 units available.', 'passed': True},
    ]}}}


@pytest.mark.parametrize('value', [None, [], 'transcript'])
def test_transcript_payload_must_be_an_object(monkeypatch, tmp_path, value):
    monkeypatch.setattr(evaluation, 'judge_metadata', lambda: pytest.fail('No model configuration'))
    with pytest.raises(ValueError, match='object'):
        run_transcript(monkeypatch, tmp_path / 'report.json', value)
    assert not list(tmp_path.iterdir())


@pytest.mark.parametrize('sample', [
    None,
    [],
    {'sample': 2, 'answer': '48 units.'},
    {'sample': 2, 'answer': '48 units.', 'passed': None},
    {'sample': 2, 'answer': '48 units.', 'passed': 1},
    {'sample': 2, 'answer': '48 units.', 'passed': 'true'},
    {'sample': 2, 'passed': True},
    {'sample': 2, 'answer': None, 'passed': True},
    {'sample': 2, 'answer': ' ', 'passed': False},
    {'sample': 2, 'answer': [], 'passed': False},
    {'sample': [], 'answer': '48 units.', 'passed': True},
    {'sample': True, 'answer': '48 units.', 'passed': True},
    {'sample': 0, 'answer': '48 units.', 'passed': True},
    {'sample': 2, 'answer': '48 units.', 'passed': False, 'failure': 'outage'},
    {'sample': 2, 'answer': '48 units.', 'passed': False, 'failure': {}},
    {'sample': 2, 'answer': None, 'passed': False,
     'failure': {'phase': 'inference'}},
    {'sample': 2, 'answer': None, 'passed': False,
     'failure': {'phase': 'inference', 'error': 42}},
    {'sample': 2, 'answer': None, 'passed': False,
     'failure': {'phase': 'inference', 'error': ' '}},
    {'sample': 2, 'answer': None, 'passed': False,
     'failure': {'phase': 'unknown', 'error': 'Outage'}},
    {'sample': 2, 'answer': None, 'passed': False,
     'failure': {'phase': 'factuality', 'error': 'Wrong stock'}},
    {'sample': 2, 'answer': '48 units.', 'passed': True,
     'failure': {'phase': 'inference', 'error': 'Outage'}},
])
def test_invalid_sample_after_valid_sample_fails_before_execution(
    monkeypatch, tmp_path, payload, sample
):
    payload['batches']['case-pack']['samples'].append(sample)
    monkeypatch.setattr(evaluation, 'judge_metadata', lambda: pytest.fail('No model configuration'))
    monkeypatch.setattr(evaluation, 'judge_answer', lambda *args: pytest.fail('No judge calls'))
    with pytest.raises(ValueError, match='sample|Sample'):
        run_transcript(monkeypatch, tmp_path / 'report.json', payload)
    assert not list(tmp_path.iterdir())


@pytest.mark.parametrize('batches', [
    None, [], {'case-pack': None}, {'case-pack': []}, {'case-pack': {}},
    {'case-pack': {'samples': None}}, {'case-pack': {'samples': {}}},
    {'case-pack': {'samples': 'invalid'}},
])
def test_invalid_batch_shapes_fail_before_execution(monkeypatch, tmp_path, payload, batches):
    payload['batches'] = batches
    monkeypatch.setattr(evaluation, 'judge_metadata', lambda: pytest.fail('No model configuration'))
    with pytest.raises(ValueError, match='batch|Batch|samples'):
        run_transcript(monkeypatch, tmp_path / 'report.json', payload)
    assert not list(tmp_path.iterdir())


@pytest.mark.parametrize('phase', ['inference', 'response-format'])
@pytest.mark.parametrize('answer', [None, '', 'Unusable response'])
def test_generator_failure_is_reported_without_judging(
    monkeypatch, tmp_path, payload, phase, answer
):
    sample = payload['batches']['case-pack']['samples'][0]
    sample.update(answer=answer, passed=False, failure={
        'sample': 1, 'phase': phase, 'error': 'No usable answer',
    })
    monkeypatch.setattr(evaluation, 'judge_metadata', lambda: ({}, {}))
    monkeypatch.setattr(evaluation, 'judge_answer', lambda *args: pytest.fail('No judge calls'))
    output = tmp_path / 'report.json'
    assert run_transcript(monkeypatch, output, payload) == 1
    report = json.loads(output.read_text())
    result = report['results'][0]
    assert result['answer'] == answer
    assert result['failure'] == sample['failure']
    assert result['executionPhase'] == 'generator'
    assert report['summary']['overall']['generatorExecutionErrors'] == 1
    assert report['summary']['overall']['requestAttempts'] == 0


@pytest.mark.parametrize('suffix', ['.json', '.jsonl'])
@pytest.mark.parametrize('kind', ['file', 'directory', 'dangling-symlink'])
def test_report_conflicts_fail_before_execution(
    monkeypatch, tmp_path, payload, suffix, kind
):
    output = tmp_path / 'report.json'
    conflict = output.with_suffix(suffix)
    if kind == 'file':
        conflict.write_text('Existing evidence\n')
    elif kind == 'directory':
        conflict.mkdir()
    else:
        conflict.symlink_to(tmp_path / 'missing-target')
    monkeypatch.setattr(evaluation, 'judge_metadata', lambda: pytest.fail('No model configuration'))
    monkeypatch.setattr(evaluation, 'judge_answer', lambda *args: pytest.fail('No judge calls'))
    with pytest.raises(ValueError, match='already exists'):
        run_transcript(monkeypatch, output, payload)
    assert list(tmp_path.iterdir()) == [conflict]
    if kind == 'file':
        assert conflict.read_text() == 'Existing evidence\n'
    elif kind == 'directory':
        assert conflict.is_dir()
    else:
        assert conflict.is_symlink()


def test_report_and_evidence_paths_must_differ(monkeypatch, tmp_path, payload):
    monkeypatch.setattr(evaluation, 'judge_metadata', lambda: pytest.fail('No model configuration'))
    with pytest.raises(ValueError, match='different'):
        run_transcript(monkeypatch, tmp_path / 'report.jsonl', payload)
    assert not list(tmp_path.iterdir())


@pytest.mark.parametrize('failure_point', ['judge', 'postprocessing'])
def test_execution_errors_preserve_requests_in_both_reports(
    monkeypatch, tmp_path, payload, failure_point
):
    calls = [{'httpStatus': 200, 'completed': True, 'attempt': 1}]

    def judge(*args):
        if failure_point == 'judge':
            error = ValueError('Invalid verdict')
            error.judge_calls = calls
            raise error
        # Missing verdict triggers an error after the request evidence is retained.
        return {'calls': calls}

    monkeypatch.setattr(evaluation, 'judge_metadata', lambda: ({}, {}))
    monkeypatch.setattr(evaluation, 'judge_answer', judge)
    output = tmp_path / 'report.json'
    assert run_transcript(monkeypatch, output, payload) == 1
    report = json.loads(output.read_text())
    result = report['results'][0]
    assert result['calls'] == calls
    assert result['executionPhase'] == 'judge'
    assert 'error' in result
    assert report['executionSuccessful'] is False
    assert report['summary']['overall']['requestAttempts'] == 1
    assert json.loads(output.with_suffix('.jsonl').read_text().splitlines()[1]) == result
