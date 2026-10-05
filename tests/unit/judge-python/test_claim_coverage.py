
import pytest

import support_grading as grading
import judge_collection as collection


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


@pytest.mark.parametrize('mutation', ['missing', 'false-acceptance', 'wrong-truth', 'error'])
def test_collection_checks_extraction_completeness_separately_from_truth(monkeypatch, mutation):
    original = next(case for case in collection.load_cases(['extraction'])
                    if case['id'].endswith('/unsupported-ending'))
    expected = original['checks']['extraction']
    case = {**original, 'checks': {'extraction': expected}}
    def judge(*args):
        if mutation == 'error':
            raise RuntimeError('upstream failure')
        missed = mutation in ('missing', 'false-acceptance')
        return {'passed': not expected['passed'] if mutation in ('false-acceptance', 'wrong-truth') else expected['passed'],
                'claims': expected['claims'][:-1] if missed else expected['claims'], 'calls': []}
    monkeypatch.setattr(collection, 'judge_claims', judge)
    check = collection.evaluate_case(case)['checks'][0]
    assert check['status'] == ('error' if mutation == 'error' else 'failed')
    assert check['expected']['claims'] == expected['claims']
    if mutation == 'error':
        assert 'claimCoverage' not in check['actual']
    else:
        assert check['actual']['claimCoverage']['passed'] == (mutation == 'wrong-truth')
        assert check['actual']['claimCoverage']['missingClaims'] == (expected['claims'][-1:] if mutation != 'wrong-truth' else [])
        assert check['actual']['passed'] == (not expected['passed'] if mutation != 'missing' else expected['passed'])
