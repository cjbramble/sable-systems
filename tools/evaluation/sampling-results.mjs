import { stripVTControlCharacters } from 'node:util';
import fixture from '../../tests/fixtures/judge/case-pack.json' with { type: 'json' };
import comparisonFixture from '../../tests/fixtures/judge/comparison.json' with { type: 'json' };

function readTranscriptRows(text, prefix) {
  return text
    .split('\n')
    .filter((line) => line.startsWith(prefix))
    .map((line) => JSON.parse(line.slice(prefix.length)));
}

function parseSamplingScenario(text, { label, question, testName }) {
  // Normalize reporter styling before matching records; JSON-escaped answer
  // content and the original saved transcript remain unchanged.
  text = stripVTControlCharacters(text);
  const requests = readTranscriptRows(text, `${label} sampling request: `);
  const samples = readTranscriptRows(text, `${label} sample: `);
  const summaries = readTranscriptRows(text, `${label} sampling summary: `);
  if (!requests.length && !samples.length && !summaries.length) {
    if (
      text
        .split('\n')
        .some((line) => /[✓×]/u.test(line) && line.includes(testName))
    )
      throw new Error('Completed sampling test omitted its sampling evidence');
    return null;
  }
  if (
    requests.length !== 1 ||
    requests[0]?.samples !== 5 ||
    samples.length !== 5 ||
    summaries.length !== 1
  )
    throw new Error(
      `Expected one complete five-sample ${label.toLowerCase()} run`,
    );
  const request = requests[0].requestBody;
  if (
    !Array.isArray(request?.messages) ||
    request.messages.at(-1)?.content !== question
  )
    throw new Error(
      'Sampling question does not match the sampling reference fixture',
    );
  if (
    request.temperature !== 0.35 ||
    request.top_p !== 0.9 ||
    request.max_tokens !== 600 ||
    request.stream !== false ||
    Object.hasOwn(request, 'seed') ||
    request.messages.length !== 2 ||
    request.messages[0]?.role !== 'system' ||
    typeof request.messages[0].content !== 'string' ||
    !request.messages[0].content.trim() ||
    request.messages[1]?.role !== 'user'
  )
    throw new Error(
      `${label} request must use normal settings and independent messages`,
    );

  const failures = [];
  for (const [index, sample] of samples.entries()) {
    if (sample?.sample !== index + 1 || typeof sample.passed !== 'boolean')
      throw new Error('Missing, duplicated, or malformed sample verdict');
    const failure = sample.failure;
    if (sample.answer !== null && typeof sample.answer !== 'string')
      throw new Error('Malformed sample answer');
    if (sample.passed) {
      if (!sample.answer?.trim())
        throw new Error('A passing sample must contain an answer');
      if (failure !== undefined)
        throw new Error('Passing sample contains a failure');
    } else {
      if (
        failure?.sample !== sample.sample ||
        !['inference', 'response-format', 'factuality'].includes(
          failure.phase,
        ) ||
        typeof failure.error !== 'string' ||
        !failure.error.trim() ||
        (failure.phase === 'factuality' && !sample.answer?.trim())
      )
        throw new Error('Malformed sample failure evidence');
      failures.push(failure);
    }
  }
  const summary = summaries[0];
  if (
    summary?.samples !== 5 ||
    summary.passed !== 5 - failures.length ||
    !Array.isArray(summary.failures) ||
    summary.failures.length !== failures.length ||
    summary.failures.some((failure, index) =>
      ['sample', 'phase', 'error'].some(
        (field) => failure?.[field] !== failures[index][field],
      ),
    )
  )
    throw new Error(
      `${label} summary does not match the retained sample verdicts`,
    );
  // Preserve original answers/raw responses/verdicts; do not rejudge factuality here.
  return { request, samples };
}

export function parseSamplingTranscript(text) {
  return parseSamplingScenario(text, {
    label: 'Case-pack',
    question: fixture.question,
    testName: 'preserves case-pack facts across five samples',
  });
}

export function parseComparisonSamplingTranscript(text) {
  return parseSamplingScenario(text, {
    label: 'Comparison',
    question: comparisonFixture.question,
    testName: 'preserves overlapping-name comparison facts across five samples',
  });
}

const samplingScenarios = {
  'case-pack': { fixture, parseTranscript: parseSamplingTranscript },
  comparison: {
    fixture: comparisonFixture,
    parseTranscript: parseComparisonSamplingTranscript,
  },
};

export function listSamplingScenarios() {
  return Object.keys(samplingScenarios);
}

export function getSamplingScenario(name = 'case-pack') {
  if (!Object.hasOwn(samplingScenarios, name))
    throw new Error(`Unknown sampling scenario: ${name}`);
  return samplingScenarios[name];
}

// Model judging must never rescue a failed factual assertion.
export function combinedSamplingPassed(samples) {
  return (
    samples.length === 5 && samples.every((sample) => sample.passed === true)
  );
}
