import fixture from '../tests/fixtures/semantic/case-pack.json' with { type: 'json' };
import manifest from './semantic/model.json' with { type: 'json' };

export function parseSamplingTranscript(text) {
  const readRows = (prefix) =>
    text
      .split('\n')
      .filter((line) => line.startsWith(prefix))
      .map((line) => JSON.parse(line.slice(prefix.length)));
  const requests = readRows('Case-pack sampling request: ');
  const samples = readRows('Case-pack sample: ');
  if (!requests.length && !samples.length) {
    if (
      text
        .split('\n')
        .some(
          (line) =>
            /[✓×]/u.test(line) &&
            line.includes('preserves case-pack facts across five samples'),
        )
    )
      throw new Error('Completed sampling test omitted its semantic evidence');
    return null;
  }
  if (
    requests.length !== 1 ||
    requests[0].samples !== 5 ||
    samples.length !== 5
  )
    throw new Error('Expected one complete five-sample case-pack run');
  const request = requests[0].requestBody;
  if (request?.messages?.at(-1)?.content !== fixture.question)
    throw new Error(
      'Sampling question does not match the semantic reference fixture',
    );
  for (const [index, sample] of samples.entries()) {
    if (sample.sample !== index + 1 || typeof sample.passed !== 'boolean')
      throw new Error('Missing, duplicated, or malformed sample verdict');
    if (
      sample.passed &&
      (typeof sample.answer !== 'string' || !sample.answer.trim())
    )
      throw new Error('A passing sample must contain an answer');
  }
  return { request, samples };
}

export function validateSemanticReport(report, samples) {
  const isScore = (value) =>
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= -1 &&
    value <= 1;
  if (
    report?.schemaVersion !== 1 ||
    report.scenario !== fixture.scenario ||
    report.policy?.mode !== 'advisory' ||
    report.model?.id !== manifest.id ||
    report.model?.revision !== manifest.revision
  )
    throw new Error('Invalid semantic report identity or evaluation policy');
  if (
    !Array.isArray(report.samples) ||
    report.samples.length !== samples.length
  )
    throw new Error('Semantic report omitted or added sample scores');
  for (const [index, sample] of report.samples.entries()) {
    if (
      sample.sample !== samples[index].sample ||
      sample.answer !== samples[index].answer ||
      !isScore(sample.score) ||
      !Array.isArray(sample.referenceScores) ||
      sample.referenceScores.length !== fixture.references.length ||
      !sample.referenceScores.every(isScore) ||
      !Number.isInteger(sample.chunks) ||
      sample.chunks < 1
    )
      throw new Error(
        'Semantic report contains an invalid or mismatched score',
      );
  }
  if (
    !isScore(report.calibration?.minimumCorrectScore) ||
    !isScore(report.calibration?.maximumIncorrectScore) ||
    !Array.isArray(report.calibration?.examples) ||
    report.calibration.examples.length !== fixture.examples.length
  )
    throw new Error('Missing semantic calibration evidence');
  for (const [index, row] of report.calibration.examples.entries()) {
    const expected = fixture.examples[index];
    if (
      row.id !== expected.id ||
      row.text !== expected.text ||
      row.correct !== expected.correct ||
      row.split !== expected.split ||
      !isScore(row.score)
    )
      throw new Error('Mismatched or invalid calibration result');
  }
  if (
    !Array.isArray(report.pairwiseSimilarity) ||
    report.pairwiseSimilarity.length !== samples.length ||
    report.pairwiseSimilarity.some(
      (row) =>
        !Array.isArray(row) ||
        row.length !== samples.length ||
        !row.every(isScore),
    )
  )
    throw new Error('Incomplete or invalid pairwise similarity results');
  return report;
}

// Semantic similarity is supplementary. This must never rescue a factual failure.
export function combinedSamplingPassed(samples) {
  return (
    samples.length === 5 && samples.every((sample) => sample.passed === true)
  );
}
