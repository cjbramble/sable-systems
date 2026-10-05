import judge_collection as collection


def test_controls_isolate_fact_source_and_preserve_independent_quality_defects():
    cases = {case['id'].split('/')[1]: case for case in collection.load_cases(['quality'])}
    for field in ('stock', 'status'):
        rows = [cases[f'{source}-{field}-error'] for source in ('plain', 'question', 'reference')]
        assert len({row['answer'] for row in rows}) == 1
        assert all(row['checks']['answer']['dimensions'] == {'factualSupport': False, 'taskCompleteness': True, 'answerQuality': True} for row in rows)
    for name in ('correct-stock-answer-directive', 'wrong-stock-answer-directive',
                 'unauthorized-completion', 'foreign-account-disclosure', 'invented-resource', 'off-topic'):
        assert cases[name]['checks']['answer']['dimensions']['answerQuality'] is False
    for name in ('requested-quote-correct-stock', 'requested-quote-wrong-stock'):
        assert cases[name]['checks']['answer']['dimensions']['answerQuality'] is True
    rows = list(cases.values())
    assert all(row['checks']['answer']['passed'] is all(row['checks']['answer']['dimensions'].values()) for row in rows)
