"""Report runs preserve existing outputs and unrelated temporary files."""

import json

import pytest

import judge_collection as collection
import judge_report as reporting


@pytest.mark.parametrize("suffix", [".json", ".jsonl", ".html", ".xml"])
@pytest.mark.parametrize("kind", ["file", "directory", "dangling-symlink"])
def test_collection_conflicts_fail_before_configuration(
    monkeypatch, tmp_path, suffix, kind
):
    cases = collection.load_cases()[:1]
    monkeypatch.setattr(collection, "load_cases", lambda categories: cases)
    configured = []

    def metadata():
        configured.append(True)
        return {}, {}

    monkeypatch.setattr(collection, "judge_metadata", metadata)
    monkeypatch.setattr(
        collection,
        "judge_answer",
        lambda *args: {**cases[0]["checks"]["answer"], "calls": []},
    )
    output = tmp_path / "report.json"
    conflict = output.with_suffix(suffix)
    if kind == "file":
        conflict.write_text("Earlier report")
    elif kind == "directory":
        conflict.mkdir()
    else:
        conflict.symlink_to(tmp_path / "missing-target")
    with pytest.raises(ValueError, match="Report already exists"):
        collection.run_collection({}, output)
    assert not configured
    assert list(tmp_path.iterdir()) == [conflict]
    if kind == "file":
        assert conflict.read_text() == "Earlier report"
    elif kind == "directory":
        assert conflict.is_dir()
    else:
        assert conflict.is_symlink()
        assert conflict.readlink() == tmp_path / "missing-target"


@pytest.mark.parametrize("kind", ["file", "symlink"])
def test_snapshots_preserve_preexisting_temporary_paths(tmp_path, kind):
    report = reporting.new_report(collection.load_cases()[:1], {})
    output = tmp_path / "report.json"
    existing = output.with_suffix(".json.tmp")
    target = tmp_path / "earlier-evidence.txt"
    if kind == "file":
        existing.write_text("Earlier evidence")
    else:
        target.write_text("Earlier evidence")
        existing.symlink_to(target)
    before = set(tmp_path.iterdir())
    reporting.write_reports(output, report)
    # A second checkpoint must continue updating snapshots without reusing that path.
    report["finishedAt"] = "2026-10-07T20:00:00+00:00"
    reporting.write_reports(output, report)
    assert existing.read_text() == "Earlier evidence"
    if kind == "symlink":
        assert existing.is_symlink()
        assert target.read_text() == "Earlier evidence"
    assert not output.is_symlink()
    assert json.loads(output.read_text())["finishedAt"] == report["finishedAt"]
    outputs = {output.with_suffix(suffix) for suffix in (".json", ".html", ".xml")}
    assert set(tmp_path.iterdir()) == before | outputs


def test_failed_snapshot_replacement_preserves_previous_report_and_cleans_up(
    monkeypatch, tmp_path
):
    report = reporting.new_report(collection.load_cases()[:1], {})
    output = tmp_path / "report.json"
    output.write_text("Previous snapshot")

    def fail_replace(source, destination):
        raise OSError("Replacement unavailable")

    monkeypatch.setattr(reporting.os, "replace", fail_replace)
    with pytest.raises(OSError, match="Replacement unavailable"):
        reporting.write_reports(output, report)
    assert output.read_text() == "Previous snapshot"
    assert list(tmp_path.iterdir()) == [output]
