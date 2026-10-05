import io
import json
import sys

import pytest
import evaluate_support as evaluation


@pytest.mark.parametrize('phase', ['factuality', 'inference', 'judge'])
def test_live_report_separates_application_disagreement_and_execution(monkeypatch, tmp_path, phase):
    called = []
    def judge(question, answer, reference):
        called.append((question, answer, reference))
        if phase == 'judge':
            raise RuntimeError('Scripted judge outage')
        return {'passed': True, 'dimensions': dict.fromkeys(('factualSupport', 'taskCompleteness', 'answerQuality'), True), 'calls': []}
    monkeypatch.setattr(evaluation, 'judge_answer', judge)
    output = tmp_path / 'report.json'
    failure = {'sample': 1, 'phase': phase, 'error': 'Scripted source failure'} if phase != 'judge' else None
    sample = {'sample': 1, 'answer': None if phase == 'inference' else 'Original retained answer', 'passed': phase == 'judge'}
    if failure: sample['failure'] = failure
    payload = {'mode': 'transcript', 'batches': {'order-status': {'samples': [sample],
        'reference': 'Authorized order SBL-2026-000417 is partially_shipped. Original live context.',
        'request': {'messages': [{'role':'user','content':'What is the status of SBL-2026-000417? Include the order ID.'}]}}}}
    monkeypatch.setattr(sys, 'argv', ['evaluate_support.py', '--output', str(output)])
    monkeypatch.setattr(sys, 'stdin', io.StringIO(json.dumps(payload)))
    # Invoke independently: final judge failures must never produce execution success.
    code = evaluation.main()
    report = json.loads(output.read_text())
    summary = report['summary']['overall']
    assert summary['applicationFailures'] == int(phase == 'factuality')
    assert summary['judgeApplicationDisagreements'] == int(phase == 'factuality')
    assert summary['generatorExecutionErrors'] == int(phase == 'inference')
    assert summary['judgeExecutionErrors'] == int(phase == 'judge')
    assert summary['executionErrors'] == int(phase != 'factuality')
    assert report['results'][0]['reference'] == payload['batches']['order-status']['reference']
    assert report['coverage']['expectedSamples'] == report['coverage']['processedSamples'] == 1
    assert code == 1
    assert bool(called) == (phase != 'inference')


@pytest.mark.parametrize('factual_passed,judge_passed,error,expected_code', [
    (True, True, False, 0), (True, False, False, 0),
    (False, True, False, 1), (True, True, True, 1),
])
def test_transcript_verdicts_remain_advisory_and_preserve_source_evidence(
    monkeypatch, tmp_path, factual_passed, judge_passed, error, expected_code
):
    def judge(*args):
        if error:
            raise RuntimeError('API unavailable')
        return {'passed': judge_passed, 'reason': 'Scripted verdict', 'calls': []}
    monkeypatch.setattr(evaluation, 'judge_answer', judge)
    output = tmp_path / 'report.json'
    payload = {'mode': 'transcript', 'sourceTranscript': 'original.log', 'sourceSha256': 'source-digest',
               'batches': {'case-pack': {'samples': [{'sample': 1, 'answer': 'Original answer', 'passed': factual_passed}]}}}
    monkeypatch.setattr(sys, 'argv', ['evaluate_support.py', '--output', str(output)])
    monkeypatch.setattr(sys, 'stdin', io.StringIO(json.dumps(payload)))
    assert evaluation.main() == expected_code
    report = json.loads(output.read_text())
    assert report['sourceSha256'] == 'source-digest'
    result = report['results'][0]
    assert result['answer'] == 'Original answer'
    assert result['factualPassed'] is factual_passed
    assert ('error' in result) is error
    assert json.loads(output.with_suffix('.jsonl').read_text().splitlines()[1]) == result


@pytest.mark.parametrize('batches,message', [
    ({}, 'No scenarios'),
    ({'unknown': {'samples': []}}, 'unsupported scenarios'),
    ({'comparison': {'samples': []}}, 'no samples'),
    ({'case-pack': {'samples': [{'sample': 1}, {'sample': 1}]}}, 'duplicate sample IDs'),
    ({'case-pack': {'samples': [{}]}}, 'Missing'),
    ({'order-status': {'samples': [{'sample': 1}]}}, 'captured authorized reference'),
])
def test_invalid_transcripts_cannot_pass_or_call_model(monkeypatch, tmp_path, batches, message):
    monkeypatch.setattr(evaluation, 'judge_metadata', lambda: pytest.fail('No model configuration'))
    output = tmp_path / 'report.json'
    monkeypatch.setattr(sys, 'argv', ['evaluate_support.py', '--output', str(output)])
    monkeypatch.setattr(sys, 'stdin', io.StringIO(json.dumps({'mode': 'transcript', 'batches': batches})))
    with pytest.raises(ValueError, match=message):
        evaluation.main()
    assert not list(tmp_path.iterdir())
