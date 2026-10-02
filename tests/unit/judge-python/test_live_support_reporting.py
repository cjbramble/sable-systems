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
