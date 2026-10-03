"""Correction controls exercise routing without pretending scripted judgments calibrate GLM."""
import io
import json
import sys
import pytest

import evaluate_support as evaluation


@pytest.mark.parametrize('suite,filename,count', [
    ('record-access', 'record-access-controls-v1.json', 7),
    ('record-access-v2', 'record-access-controls-v2.json', 8),
])
def test_record_access_controls_withhold_labels_and_report_all_dimensions(monkeypatch, tmp_path, suite, filename, count):
    path = evaluation.ROOT / 'tests/fixtures/judge' / filename
    assert path.exists(), 'Prepare focused unavailable-record controls before changing the rubric'
    fixture = json.loads(path.read_text())
    expected = {(s['question'], row['text'], s['reference']): row for s in fixture['scenarios'] for row in s['examples']}
    assert len(expected) == count
    calls = []
    def judge(question, answer, reference):
        calls.append((question, answer, reference))
        row = expected[(question, answer, reference)]
        return {'passed': row['correct'], 'dimensions': row['expectedDimensions'], 'calls': []}
    monkeypatch.setattr(evaluation, 'judge_answer', judge)
    out = tmp_path / 'controls.json'
    monkeypatch.setattr(sys, 'argv', ['evaluate_support.py', '--output', str(out)])
    monkeypatch.setattr(sys, 'stdin', io.StringIO(json.dumps({'mode': 'validation', 'suite': suite, 'concurrency': 2})))
    assert evaluation.main() == 0
    report = json.loads(out.read_text())
    assert sorted(calls) == sorted(expected)
    assert report['coverage']['expectedSamples'] == report['coverage']['processedSamples'] == count
    assert report['summary']['overall']['labelDisagreements'] == 0
    assert report['summary']['overall']['dimensionDisagreements'] == dict.fromkeys(('factualSupport', 'taskCompleteness', 'answerQuality'), 0)
    assert report['suiteStatus'] == 'authored-calibration'
    assert report['benchmarkFreeze'] is None
    assert report['policy']['gradingRevision'] == evaluation.GRADING_REVISION
