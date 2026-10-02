"""Relocated historical review evidence must still be read under its original freeze key."""
import pytest
import benchmark_review as gate


@pytest.mark.parametrize('historical', [gate.SHEET, gate.V2_SHEET, gate.V3_SHEET])
def test_historical_review_path_resolves_to_identical_report_bytes(tmp_path, historical):
    relocated = tmp_path / 'reports' / historical.split('/')[-1]
    relocated.parent.mkdir()
    relocated.write_bytes(b'Original reviewed bytes\n')
    assert gate.resolve_frozen_path(tmp_path, historical) == relocated
    assert gate.digest(gate.resolve_frozen_path(tmp_path, historical)) == gate.digest(relocated)
    original = tmp_path / historical
    original.parent.mkdir()
    original.write_bytes(b'Original snapshot location\n')
    assert gate.resolve_frozen_path(tmp_path, historical) == original


def test_missing_evaluator_source_cannot_resolve_to_a_report(tmp_path):
    name = 'tools/evaluation/support_grading.py'
    substitute = tmp_path / 'reports/support_grading.py'
    substitute.parent.mkdir()
    substitute.write_text('Untrusted substitute')
    path = gate.resolve_frozen_path(tmp_path, name)
    assert path == tmp_path / name
    with pytest.raises(FileNotFoundError):
        gate.digest(path)
