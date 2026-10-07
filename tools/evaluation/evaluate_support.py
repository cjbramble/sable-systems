"""Command-line entry point for collection and transcript judging."""

import argparse
import json
import sys
from pathlib import Path

from judge_inputs import TranscriptInput
from transcript_evaluation import run_transcript


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    payload = json.load(sys.stdin)
    if not isinstance(payload, dict):
        raise ValueError("Judge payload must be an object")
    if "suite" in payload:
        raise ValueError("Historical judge suite selection is no longer supported")
    mode = payload.get("mode")
    if mode == "collection":
        from judge_collection import run_collection

        return run_collection(payload, args.output)
    if mode != "transcript":
        raise ValueError("Choose judge mode collection or transcript")
    if payload.get("categories") or payload.get("list"):
        raise ValueError(
            "Transcript mode cannot select collection categories or list cases"
        )
    return run_transcript(TranscriptInput.model_validate(payload), Path(args.output))


if __name__ == "__main__":
    raise SystemExit(main())
