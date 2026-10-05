import io
import json
import sys

import pytest

import support_grading as grading
import evaluate_support as evaluation


def test_missed_false_claim_cannot_hide_behind_supported_stock():
    result = grading.assess_claim_coverage('48 units available. Delivery tomorrow.',
                                         ['48 units available', 'Delivery tomorrow'], ['48 units available'])
    assert result['passed'] is False
    assert result['missingClaims'] == ['Delivery tomorrow']
    assert result['matches'][0]['extractedIndices'] == [0]


def test_merged_quote_can_cover_every_claim():
    answer = '48 units available; pack size six.'
    result = grading.assess_claim_coverage(answer, ['48 units available', 'pack size six'], [answer])
    assert result['passed']
    assert [item['extractedIndices'] for item in result['matches']] == [[0], [0]]


def test_source_quote_and_gold_must_preserve_negation():
    result = grading.assess_claim_coverage('Partial packs are not permitted.',
                                         ['Partial packs are not permitted'], ['permitted'])
    assert not result['passed']
    assert result['missingClaims'] == ['Partial packs are not permitted']
    assert result['unmatchedClaims'] == ['permitted']


def test_non_source_fact_is_reported_even_if_reference_supports_it():
    result = grading.assess_claim_coverage('48 units available.', ['48 units available'],
                                         ['48 units available', 'Orders require packs of six.'])
    assert not result['passed']
    assert result['nonSourceQuotes'] == ['Orders require packs of six.']


def test_reference_detail_omitted_from_answer_is_not_an_extraction_requirement():
    result = grading.assess_claim_coverage('48 units available.', ['48 units available'], ['48 units available.'])
    assert result['passed']


def test_courtesy_extracted_as_claim_is_unmatched():
    result = grading.assess_claim_coverage('Thanks. 48 units available.', ['48 units available'],
                                         ['Thanks.', '48 units available'])
    assert result['unmatchedClaims'] == ['Thanks.']
    assert not result['passed']


@pytest.mark.parametrize('quote', ['48', '48 units available', 'Nova'])
def test_subword_and_number_substrings_cannot_supply_a_quote(quote):
    assert not grading.quote_spans('148 units available. SuperNova.', quote)


@pytest.mark.parametrize('expected', [None, [], '48', ['tomorrow'], ['48', '48']])
def test_invalid_gold_is_rejected(expected):
    with pytest.raises(ValueError):
        grading.assess_claim_coverage('48 units available.', expected, ['48 units available'])


@pytest.mark.parametrize('claims', [[], [' ']])
def test_empty_extraction_schema_is_rejected(claims):
    with pytest.raises(ValueError):
        grading.SourceClaims.model_validate({'claims': claims})


def run_report(monkeypatch, tmp_path, judge):
    monkeypatch.setattr(evaluation, 'judge_claims', judge)
    path = tmp_path / 'report.json'
    monkeypatch.setattr(sys, 'argv', ['evaluate_support.py', '--output', str(path)])
    monkeypatch.setattr(sys, 'stdin', io.StringIO(json.dumps({'mode': 'validation', 'suite': 'extraction'})))
    return evaluation.main(), json.loads(path.read_text())


def test_correct_support_label_does_not_hide_missing_claim(monkeypatch, tmp_path):
    fixture = json.loads((evaluation.ROOT / 'tests/fixtures/judge/archive/extraction-controls-v1.json').read_text())
    rows = iter(row for scenario in fixture['scenarios'] for row in scenario['examples'])
    def judge(*_):
        row = next(rows)
        claims = list(row['expectedClaims'])
        if row['id'] == 'unsupported-ending':
            claims.pop()
        return {'passed': row['correct'], 'score': int(row['correct']), 'claims': claims, 'calls': [], 'reason': 'Scripted'}
    code, report = run_report(monkeypatch, tmp_path, judge)
    assert code == 1
    summary = report['summary']['overall']
    assert summary['extractionFailures'] == summary['missingClaims'] == 1
    assert summary['supportLabelDisagreements'] == summary['falseAcceptances'] == 0
    assert report['executionSuccessful'] and not report['extractionSuccessful']
    assert summary['coveredClaims'] == summary['expectedClaims'] - 1


def test_only_true_extracted_claims_can_still_be_false_acceptance(monkeypatch, tmp_path):
    fixture = json.loads((evaluation.ROOT / 'tests/fixtures/judge/archive/extraction-controls-v1.json').read_text())
    rows = iter(row for scenario in fixture['scenarios'] for row in scenario['examples'])
    def judge(*_):
        row = next(rows)
        missed = row['id'] == 'unsupported-ending'
        return {'passed': True if missed else row['correct'], 'claims': row['expectedClaims'][:1] if missed else row['expectedClaims'], 'calls': []}
    code, report = run_report(monkeypatch, tmp_path, judge)
    assert code == 1
    assert report['summary']['overall']['falseAcceptances'] == 1
    assert report['summary']['overall']['extractionFailures'] == 1


def test_complete_extraction_does_not_hide_wrong_truth_verdict(monkeypatch, tmp_path):
    fixture = json.loads((evaluation.ROOT / 'tests/fixtures/judge/archive/extraction-controls-v1.json').read_text())
    rows = iter(row for scenario in fixture['scenarios'] for row in scenario['examples'])
    def judge(*_):
        row = next(rows)
        return {'passed': not row['correct'] if row['id'] == 'unsupported-ending' else row['correct'], 'claims': row['expectedClaims'], 'calls': []}
    code, report = run_report(monkeypatch, tmp_path, judge)
    assert code == 1
    assert report['extractionSuccessful']
    assert report['summary']['overall']['supportLabelDisagreements'] == 1
    assert report['summary']['overall']['extractionFailures'] == 0


def test_gold_inventory_is_never_sent_to_extractor(monkeypatch):
    calls = []
    class Judge:
        def __init__(self):
            self.requests = calls
        def generate(self, prompt, schema):
            calls.append(prompt)
            if schema is grading.SourceClaims:
                return schema.model_validate({'claims': ['48 units available.']})
            return schema.model_validate({'verdicts': [{'verdict': 'yes', 'reason': None}]})
    monkeypatch.setattr(grading, 'OpenRouterJudge', Judge)
    result = grading.judge_claims('Give stock and pack size.', '48 units available.', '48 available; pack size six.')
    assert result['passed']
    assert 'pack size' not in calls[0]
    assert 'expectedClaims' not in calls[0]
    assert grading.EXTRACTION_RULES in calls[0]


def test_execution_error_leaves_claims_unassessed_not_passed(monkeypatch, tmp_path):
    fixture = json.loads((evaluation.ROOT / 'tests/fixtures/judge/archive/extraction-controls-v1.json').read_text())
    rows = iter(row for scenario in fixture['scenarios'] for row in scenario['examples'])
    def judge(*_):
        row = next(rows)
        if row['id'] == 'unsupported-ending':
            raise RuntimeError('upstream failure')
        return {'passed': row['correct'], 'claims': row['expectedClaims'], 'calls': []}
    code, report = run_report(monkeypatch, tmp_path, judge)
    assert code == 1 and not report['executionSuccessful']
    summary = report['summary']['overall']
    assert summary['executionErrors'] == 1
    assert summary['unassessedClaims'] == 2
    assert summary['expectedClaims'] == summary['coveredClaims'] + summary['missingClaims'] + summary['unassessedClaims']
