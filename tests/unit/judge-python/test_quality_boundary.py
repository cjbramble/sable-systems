import io
import json
import sys

import pytest

import evaluate_support as evaluation


@pytest.mark.parametrize('suite,filename,count,status', [
    ('quality', 'quality-controls-v1.json', 17, 'authored-calibration'),
    ('calibration', 'qualification-v1.json', 32, 'retired-calibration'),
    ('calibration-v2', 'qualification-v2.json', 40, 'retired-calibration'),
])
def test_calibration_reports_current_rubric_without_benchmark_approval(monkeypatch, tmp_path, suite, filename, count, status):
    fixture = json.loads((evaluation.ROOT / 'tests/fixtures/judge' / filename).read_text())
    expected = {(s['question'], row['text'], s['reference']): row
                for s in fixture['scenarios'] for row in s['examples']}
    calls = []

    def judge(question, answer, reference):
        calls.append((question, answer, reference))
        row = expected[(question, answer, reference)]
        return {'passed': row['correct'], 'score': int(row['correct']),
                'dimensions': row['expectedDimensions'], 'reason': 'Scripted routing check', 'calls': []}

    monkeypatch.setattr(evaluation, 'judge_answer', judge)
    output = tmp_path / 'calibration.json'
    monkeypatch.setattr(sys, 'argv', ['evaluate_support.py', '--output', str(output)])
    monkeypatch.setattr(sys, 'stdin', io.StringIO(json.dumps({'mode': 'validation', 'suite': suite, 'concurrency': 4})))
    assert evaluation.main() == 0
    report = json.loads(output.read_text())
    assert sorted(calls) == sorted(expected)
    assert report['coverage']['expectedSamples'] == report['coverage']['processedSamples'] == count
    assert report['suiteStatus'] == status
    assert report['benchmarkFreeze'] is None
    assert report['policy']['gradingRevision'] == 14
    assert report['policy']['mode'] == 'advisory'


def test_original_approval_cannot_authorize_corrected_rubric(monkeypatch, tmp_path):
    monkeypatch.setattr(evaluation, 'judge_answer', lambda *args: pytest.fail('An exposed freeze cannot authorize live calls'))
    output = tmp_path / 'qualification.json'
    monkeypatch.setattr(sys, 'argv', ['evaluate_support.py', '--output', str(output)])
    monkeypatch.setattr(sys, 'stdin', io.StringIO(json.dumps({'mode': 'validation', 'suite': 'qualification', 'concurrency': 4})))
    with pytest.raises(ValueError, match='Qualification freeze mismatch'):
        evaluation.main()
    assert not output.exists()
    assert not output.with_suffix('.jsonl').exists()


def test_controls_isolate_fact_source_and_preserve_independent_quality_defects():
    fixture = json.loads((evaluation.ROOT / 'tests/fixtures/judge/quality-controls-v1.json').read_text())
    cases = {scenario['id']: scenario for scenario in fixture['scenarios']}
    for field in ('stock', 'status'):
        rows = [cases[f'{source}-{field}-error']['examples'][0] for source in ('plain', 'question', 'reference')]
        assert len({row['text'] for row in rows}) == 1
        assert all(row['expectedDimensions'] == {'factualSupport': False, 'taskCompleteness': True, 'answerQuality': True} for row in rows)
    for name in ('correct-stock-answer-directive', 'wrong-stock-answer-directive',
                 'unauthorized-completion', 'foreign-account-disclosure', 'invented-resource', 'off-topic'):
        assert cases[name]['examples'][0]['expectedDimensions']['answerQuality'] is False
    for name in ('requested-quote-correct-stock', 'requested-quote-wrong-stock'):
        assert cases[name]['examples'][0]['expectedDimensions']['answerQuality'] is True
    rows = [row for s in fixture['scenarios'] for row in s['examples']]
    assert all(row['correct'] is all(row['expectedDimensions'].values()) for row in rows)
