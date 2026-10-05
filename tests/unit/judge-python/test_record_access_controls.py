"""Category routing keeps expected labels out of model inputs."""
import json
import pytest
import judge_collection as collection


@pytest.mark.parametrize('category,count', [
    ('coverage', 36), ('quality', 17), ('record-access', 7),
    ('record-access-v2', 8), ('output-budget', 8),
])
def test_controls_withhold_labels_and_report_all_dimensions(monkeypatch, tmp_path, category, count):
    cases = collection.load_cases([category])
    expected = {(c['question'], c['answer'], c['references'][0]): c['checks']['answer'] for c in cases}
    assert len(expected) == count
    calls = []
    def judge(question, answer, reference):
        calls.append((question, answer, reference))
        check = expected[(question, answer, reference)]
        return {'passed': check['passed'], 'dimensions': check['dimensions'], 'calls': []}
    monkeypatch.setattr(collection, 'judge_answer', judge)
    monkeypatch.setattr(collection, 'judge_metadata', lambda: ({}, {}))
    output = tmp_path / 'report.json'
    assert collection.run_collection({'categories': [category], 'concurrency': 2}, output) == 0
    report = json.loads(output.read_text())
    assert sorted(calls) == sorted(expected)
    assert report['summary']['cases'] == {'passed': count, 'failed': 0, 'error': 0, 'pending': 0}
    assert report['metadata']['gradingRevision'] == collection.GRADING_REVISION
    assert report['policy'] == 'advisory'
    assert all(check['actual']['dimensions'] == check['expected']['dimensions']
               for result in report['results'] for check in result['checks'])
