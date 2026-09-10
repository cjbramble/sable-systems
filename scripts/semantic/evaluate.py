"""Local-only Sentence Transformers scoring. JSON in/out; diagnostics on stderr."""

import argparse
import contextlib
import hashlib
import importlib.metadata
import json
import math
import os
from pathlib import Path
import sys
import tomllib

ROOT = Path(__file__).resolve().parents[2]
MANIFEST_PATH = Path(__file__).with_name("model.json")
FIXTURE_PATH = ROOT / "tests/fixtures/semantic/case-pack.json"


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def download_model(manifest):
    from huggingface_hub import snapshot_download

    destination = ROOT / manifest["directory"]
    snapshot_download(
        repo_id=manifest["id"],
        revision=manifest["revision"],
        local_dir=destination,
        allow_patterns=manifest["files"],
        token=False,
    )
    # A receipt makes local file drift detectable without any network at test time.
    receipt = {
        "id": manifest["id"], "revision": manifest["revision"],
        "files": {name: digest(destination / name) for name in manifest["files"]},
    }
    (destination / "source.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps({"downloaded": str(destination), "revision": manifest["revision"]}))


def evaluate(payload, manifest):
    # Downloads are an explicit setup step, never a fallback during evaluation.
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    os.environ["HF_HUB_DISABLE_PROGRESS_BARS"] = "1"
    os.environ["TOKENIZERS_PARALLELISM"] = "false"
    from sentence_transformers import SentenceTransformer
    import numpy as np
    import torch

    dependencies = tomllib.loads(Path(__file__).with_name("pyproject.toml").read_text())["project"]["dependencies"]
    for dependency in dependencies:
        name, version = dependency.split("==")
        if importlib.metadata.version(name) != version:
            raise ValueError(f"Unexpected {name} version; rerun setup:semantic")

    directory = ROOT / manifest["directory"]
    receipt = json.loads((directory / "source.json").read_text())
    hashes = {name: digest(directory / name) for name in manifest["files"]}
    if receipt != {"id": manifest["id"], "revision": manifest["revision"], "files": hashes}:
        raise ValueError("Local embedding model differs from its setup receipt; rerun setup:semantic")

    fixture = json.loads(FIXTURE_PATH.read_text())
    references = fixture["references"]
    examples = fixture["examples"]
    if fixture["schemaVersion"] != 1 or len(references) < 2:
        raise ValueError("Unsupported or incomplete semantic reference fixture")
    if len({row["id"] for row in examples}) != len(examples):
        raise ValueError("Duplicate calibration example IDs")
    for split in ("calibration", "holdout"):
        for correct in (True, False):
            if not any(row["split"] == split and row["correct"] is correct for row in examples):
                raise ValueError("Both labels are required in calibration and holdout")
    samples = payload["samples"]
    if not isinstance(samples, list):
        raise ValueError("Expected a samples list")
    for row in samples:
        if not isinstance(row.get("answer"), str) or not row["answer"].strip():
            raise ValueError("Only nonempty model answers can be scored")

    torch.set_num_threads(1)
    with contextlib.redirect_stdout(sys.stderr):
        model = SentenceTransformer(
            str(directory), device="cpu", local_files_only=True,
            trust_remote_code=False, model_kwargs={"use_safetensors": True},
        )
        model.eval()

    def encode_full(text):
        if not isinstance(text, str) or not text.strip():
            raise ValueError("Reference and calibration texts must be nonempty strings")
        tokens = model.tokenizer.encode(text, add_special_tokens=False, truncation=False, verbose=False)
        budget = model.max_seq_length - model.tokenizer.num_special_tokens_to_add(pair=False)
        # Include every token, rather than silently dropping the end of long answers.
        chunks = [model.tokenizer.decode(tokens[i:i + budget]) for i in range(0, len(tokens), budget)]
        if any(len(model.tokenizer.encode(chunk, truncation=False)) > model.max_seq_length for chunk in chunks):
            raise ValueError("A semantic chunk exceeds the encoder token limit")
        with contextlib.redirect_stdout(sys.stderr):
            vectors = model.encode(chunks, normalize_embeddings=True, show_progress_bar=False)
        # Token-weighted pooling, then normalization, is part of this evaluator's versioned policy.
        weights = [min(budget, len(tokens) - i) for i in range(0, len(tokens), budget)]
        vector = np.average(vectors, axis=0, weights=weights)
        norm = float(np.linalg.norm(vector))
        if not math.isfinite(norm) or norm <= 0:
            raise ValueError("Invalid sentence embedding")
        return vector / norm, len(tokens), len(chunks)

    reference_vectors = np.stack([encode_full(text)[0] for text in references])

    def score(text):
        vector, tokens, chunks = encode_full(text)
        similarities = np.clip(reference_vectors @ vector, -1, 1)
        if not np.isfinite(similarities).all():
            raise ValueError("Non-finite semantic score")
        return {
            "score": float(similarities.max()),
            "referenceScores": similarities.tolist(),
            "tokens": tokens, "chunks": chunks,
        }, vector

    scored_examples = [{**row, **score(row["text"])[0]} for row in examples]
    development = [row for row in scored_examples if row["split"] == "calibration"]
    minimum_good = min(row["score"] for row in development if row["correct"])
    maximum_bad = max(row["score"] for row in development if not row["correct"])
    candidate = (minimum_good + maximum_bad) / 2 if maximum_bad < minimum_good else None
    holdout_errors = None if candidate is None else [
        row["id"] for row in scored_examples
        if row["split"] == "holdout" and (row["score"] >= candidate) != row["correct"]
    ]
    scored_samples, vectors = [], []
    for row in samples:
        result, vector = score(row["answer"])
        scored_samples.append({"sample": row["sample"], "answer": row["answer"], **result})
        vectors.append(vector)
    pairwise = [] if not vectors else np.clip(np.stack(vectors) @ np.stack(vectors).T, -1, 1).tolist()
    return {
        "schemaVersion": 1,
        "scenario": fixture["scenario"],
        "policy": {
            "mode": "advisory", "metric": "maximum_reference_cosine",
            "longText": "token_weighted_mean_of_all_chunk_embeddings_then_normalize",
            "reason": "Similarity is not a factuality judge; no threshold is approved for enforcement.",
        },
        "model": {"id": manifest["id"], "revision": manifest["revision"], "device": "cpu", "files": hashes},
        "versions": {name: importlib.metadata.version(name) for name in ("sentence-transformers", "torch", "transformers", "huggingface-hub")},
        "fixtureSha256": digest(FIXTURE_PATH),
        "evaluatorSha256": digest(Path(__file__)),
        "pythonVersion": sys.version,
        "lockSha256": digest(Path(__file__).with_name("uv.lock")),
        "calibration": {
            "status": "overlap" if candidate is None else "candidate_requires_review",
            "minimumCorrectScore": minimum_good, "maximumIncorrectScore": maximum_bad,
            "candidateThreshold": candidate, "holdoutErrors": holdout_errors,
            "examples": scored_examples,
        },
        "samples": scored_samples, "pairwiseSimilarity": pairwise,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--download", action="store_true")
    parser.add_argument("--calibrate", action="store_true")
    args = parser.parse_args()
    manifest = json.loads(MANIFEST_PATH.read_text())
    if args.download:
        download_model(manifest)
    else:
        payload = {"samples": []} if args.calibrate else json.load(sys.stdin)
        print(json.dumps(evaluate(payload, manifest), allow_nan=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Semantic evaluator failed: {error}", file=sys.stderr)
        sys.exit(1)
