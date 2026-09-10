import { expect, it } from 'vitest';
import {
  combinedSamplingPassed,
  parseComparisonSamplingTranscript,
  parseSamplingTranscript,
  validateSemanticReport,
} from '../../scripts/semantic-results.mjs';
import manifest from '../../scripts/semantic/model.json';
import fixture from '../fixtures/semantic/case-pack.json';
import comparisonFixture from '../fixtures/semantic/comparison.json';

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

it('isolates complete comparison transcripts while retaining failed samples and rejecting damaged evidence', () => {
  // Authored independently of the shared question used by the producer/parser.
  const question =
    'Compare Coldstart Rack Controller R2 versus Redline Power Cell R12. Use one line per product with these labeled fields: item number, price, case pack, lead time, available units.';
  expect(comparisonFixture.question).toBe(question);
  const request = {
    samples: 5,
    requestBody: {
      temperature: 0.35,
      top_p: 0.9,
      max_tokens: 600,
      stream: false,
      messages: [
        { role: 'system', content: 'Authorized comparison context' },
        { role: 'user', content: question },
      ],
    },
  };
  const samples = Array.from({ length: 5 }, (_, index) => ({
    sample: index + 1,
    httpStatus: 200,
    responseBody: JSON.stringify({
      choices: [{ message: { content: `Comparison answer ${index + 1}` } }],
    }),
    answer: `Comparison answer ${index + 1}`,
    passed: true,
  }));
  const summary = { samples: 5, passed: 5, failures: [] };
  const row = (label: string, value: unknown) =>
    `Comparison ${label}: ${JSON.stringify(value)}`;
  const lines = [
    row('sampling request', request),
    ...samples.map((sample) => row('sample', sample)),
    row('sampling summary', summary),
  ];
  const parseLines = (rows: string[]) =>
    parseComparisonSamplingTranscript(rows.join('\n'));
  const expected = { request: request.requestBody, samples };
  expect(parseLines(lines)).toEqual(expected);

  const casePack = [
    `Case-pack sampling request: ${JSON.stringify({
      samples: 5,
      requestBody: { messages: [{ role: 'user', content: fixture.question }] },
    })}`,
    ...samples.map(
      (sample) =>
        `Case-pack sample: ${JSON.stringify({ ...sample, answer: 'Case-pack answer' })}`,
    ),
  ];
  expect(parseLines(casePack)).toBeNull();
  expect(parseSamplingTranscript(lines.join('\n'))).toBeNull();
  expect(parseLines([...casePack, ...lines])).toEqual(expected);
  expect(
    parseSamplingTranscript([...lines, ...casePack].join('\n'))?.samples,
  ).toEqual(
    samples.map((sample) => ({ ...sample, answer: 'Case-pack answer' })),
  );

  const name =
    'preserves overlapping-name comparison facts across five samples';
  expect(parseLines([`↓ ${name}`])).toBeNull();
  for (const marker of ['✓', '×']) {
    expect(() => parseLines([`${marker} ${name}`])).toThrow('omitted');
  }

  // Dropping any request, sample, or summary must fail closed, not silently skip.
  for (let index = 0; index < lines.length; index++) {
    expect(() => parseLines(lines.filter((_, i) => i !== index))).toThrow(
      'complete',
    );
  }
  expect(() => parseLines([lines.at(-1)!])).toThrow('complete');
  expect(() => parseLines([...lines, lines[0]])).toThrow('complete');
  expect(() => parseLines([...lines, lines.at(-1)!])).toThrow('complete');
  expect(() =>
    parseLines([row('sampling request', null), ...lines.slice(1)]),
  ).toThrow('complete');
  expect(() => parseLines(['Comparison sample: {broken', ...lines])).toThrow();
  for (const invalid of [
    { ...samples[0], sample: 2 },
    { ...samples[0], passed: 'true' },
    { ...samples[0], answer: ' ' },
    {
      ...samples[0],
      failure: { sample: 1, phase: 'factuality', error: 'Failed' },
    },
    { ...samples[0], passed: false },
    null,
  ]) {
    expect(() =>
      parseLines([lines[0], row('sample', invalid), ...lines.slice(2)]),
    ).toThrow();
  }
  for (const changes of [
    { messages: [{ role: 'user', content: fixture.question }] },
    { messages: [{ role: 'user', content: question }] },
    { temperature: 0 },
    { top_p: 1 },
    { max_tokens: 1200 },
    { seed: 42 },
    { stream: true },
  ]) {
    expect(() =>
      parseLines([
        row('sampling request', {
          ...request,
          requestBody: { ...request.requestBody, ...changes },
        }),
        ...lines.slice(1),
      ]),
    ).toThrow();
  }
  expect(() =>
    parseLines([
      ...lines.slice(0, -1),
      row('sampling summary', { ...summary, passed: 4 }),
    ]),
  ).toThrow('summary');

  for (const phase of ['inference', 'response-format', 'factuality']) {
    const failure = { sample: 2, phase, error: `Retained ${phase} failure` };
    const failed = {
      ...samples[1],
      passed: false,
      answer: phase === 'factuality' ? samples[1].answer : null,
      httpStatus: phase === 'inference' ? undefined : 200,
      responseBody: phase === 'inference' ? undefined : samples[1].responseBody,
      failure,
    };
    const failedLines = lines.map((line, index) =>
      index === 2 ? row('sample', failed) : line,
    );
    // Failed verdicts must agree with the summary, never be promoted to passes.
    expect(() => parseLines(failedLines)).toThrow('summary');
    failedLines[6] = row('sampling summary', {
      samples: 5,
      passed: 4,
      failures: [failure],
    });
    const parsed = parseLines(failedLines)!;
    expect(parsed.samples[1]).toEqual(failed);
    expect(combinedSamplingPassed(parsed.samples)).toBe(false);
    expect(() =>
      parseLines([
        ...failedLines.slice(0, -1),
        row('sampling summary', {
          samples: 5,
          passed: 4,
          failures: [{ ...failure, error: 'Changed' }],
        }),
      ]),
    ).toThrow('summary');
  }
});
