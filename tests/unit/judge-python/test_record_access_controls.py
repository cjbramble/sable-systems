"""Correction controls exercise routing without pretending scripted judgments calibrate GLM."""
import io
import json
import sys

import evaluate_support as evaluation


def test_record_access_controls_withhold_labels_and_report_all_dimensions(monkeypatch, tmp_path):
    path = evaluation.ROOT / 'tests/fixtures/judge/record-access-controls-v1.json'
    assert path.exists(), 'Prepare focused unavailable-record controls before changing the rubric'
    fixture = json.loads(path.read_text())
    expected = {(s['question'], row['text'], s['reference']): row for s in fixture['scenarios'] for row in s['examples']}
    assert len(expected) == 7
    calls = []
    def judge(question, answer, reference):
        calls.append((question, answer, reference))
        row = expected[(question, answer, reference)]
        return {'passed': row['correct'], 'dimensions': row['expectedDimensions'], 'calls': []}
    monkeypatch.setattr(evaluation, 'judge_answer', judge)
    out = tmp_path / 'controls.json'
    monkeypatch.setattr(sys, 'argv', ['evaluate_support.py', '--output', str(out)])
    monkeypatch.setattr(sys, 'stdin', io.StringIO(json.dumps({'mode': 'validation', 'suite': 'record-access', 'concurrency': 2})))
    assert evaluation.main() == 0
    report = json.loads(out.read_text())
    assert sorted(calls) == sorted(expected)
    assert report['coverage']['expectedSamples'] == report['coverage']['processedSamples'] == 7
    assert report['summary']['overall']['labelDisagreements'] == 0
    assert report['summary']['overall']['dimensionDisagreements'] == dict.fromkeys(('factualSupport', 'taskCompleteness', 'answerQuality'), 0)
    assert report['suiteStatus'] == 'authored-calibration'
    assert report['benchmarkFreeze'] is None
    assert report['policy']['gradingRevision'] == 14
