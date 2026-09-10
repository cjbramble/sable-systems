import { expect, it } from 'vitest';
import {
  combinedSamplingPassed,
  parseSamplingTranscript,
  validateSemanticReport,
} from '../../scripts/semantic-results.mjs';
import manifest from '../../scripts/semantic/model.json';
import fixture from '../fixtures/semantic/case-pack.json';

it('keeps factual failures and incomplete semantic evidence from becoming successful sampling runs', () => {
  const samples = Array.from({ length: 5 }, (_, index) => ({
    sample: index + 1,
    answer: `Test answer ${index + 1}`,
    passed: true,
  }));
  const request = {
    samples: 5,
    requestBody: { messages: [{ role: 'user', content: fixture.question }] },
  };
  const transcript = (rows = samples) =>
    [
      `Case-pack sampling request: ${JSON.stringify(request)}`,
      ...rows.map((row) => `Case-pack sample: ${JSON.stringify(row)}`),
    ].join('\n');
  const report = {
    schemaVersion: 1,
    scenario: fixture.scenario,
    policy: { mode: 'advisory' },
    model: { id: manifest.id, revision: manifest.revision },
    samples: samples.map((sample) => ({
      ...sample,
      score: 0.99,
      referenceScores: [0.99, 0.98],
      chunks: 1,
    })),
    calibration: {
      minimumCorrectScore: 0.75,
      maximumIncorrectScore: 0.99,
      examples: fixture.examples.map((example) => ({ ...example, score: 0.8 })),
    },
    pairwiseSimilarity: samples.map(() => samples.map(() => 0.99)),
  };
  expect(parseSamplingTranscript(transcript())?.samples).toEqual(samples);
  expect(validateSemanticReport(report, samples)).toBe(report);
  expect(combinedSamplingPassed(samples)).toBe(true);

  const failed = samples.map((sample) => ({
    ...sample,
    passed: sample.sample !== 2,
  }));
  // High semantic similarity never changes the original factual verdict.
  expect(validateSemanticReport(report, failed)).toBe(report);
  expect(
    combinedSamplingPassed(
      parseSamplingTranscript(transcript(failed))!.samples,
    ),
  ).toBe(false);
  expect(combinedSamplingPassed(samples.slice(1))).toBe(false);
  expect(() => parseSamplingTranscript(transcript(samples.slice(1)))).toThrow(
    'complete five-sample',
  );
  expect(() =>
    parseSamplingTranscript(transcript(samples.map(() => samples[0]))),
  ).toThrow('duplicated');
  expect(
    parseSamplingTranscript('A filtered fixed-seed test without sampling'),
  ).toBeNull();
  expect(() =>
    parseSamplingTranscript('✓ preserves case-pack facts across five samples'),
  ).toThrow('omitted its semantic evidence');
  expect(() =>
    parseSamplingTranscript(
      transcript().replace(fixture.question, 'Unrelated question'),
    ),
  ).toThrow('question');

  for (const score of [NaN, Infinity, -2, 2]) {
    const invalid = structuredClone(report);
    invalid.samples[1].score = score;
    expect(() => validateSemanticReport(invalid, samples)).toThrow(
      'invalid or mismatched',
    );
  }
  const missing = structuredClone(report);
  missing.samples.pop();
  expect(() => validateSemanticReport(missing, samples)).toThrow(
    'omitted or added',
  );
  const mismatched = structuredClone(report);
  mismatched.samples[0].answer = 'Different generated response';
  expect(() => validateSemanticReport(mismatched, samples)).toThrow(
    'mismatched',
  );
  const badCalibration = structuredClone(report);
  badCalibration.calibration.examples[0].score = NaN;
  expect(() => validateSemanticReport(badCalibration, samples)).toThrow(
    'calibration result',
  );
  const badPairwise = structuredClone(report);
  badPairwise.pairwiseSimilarity.pop();
  expect(() => validateSemanticReport(badPairwise, samples)).toThrow(
    'pairwise',
  );
});
