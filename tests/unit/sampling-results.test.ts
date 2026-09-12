import { expect, it } from 'vitest';
import {
  combinedSamplingPassed,
  parseComparisonSamplingTranscript,
  parseSamplingTranscript,
} from '../../scripts/sampling-results.mjs';
import fixture from '../fixtures/judge/case-pack.json';
import comparisonFixture from '../fixtures/judge/comparison.json';

// Independent contract controls: do not build these through the fixture helper
// or import the producer's generation defaults to define expected evidence.
const parserCases = [
  {
    label: 'Case-pack',
    question:
      'Are 310 units of the Redline Power Cell R12 available? Include the available quantity, case-pack validity, and any stock shortfall.',
    fixture,
    name: 'preserves case-pack facts across five samples',
    parse: parseSamplingTranscript,
  },
  {
    label: 'Comparison',
    question:
      'Compare Coldstart Rack Controller R2 versus Redline Power Cell R12. Use one line per product with these labeled fields: item number, price, case pack, lead time, available units.',
    fixture: comparisonFixture,
    name: 'preserves overlapping-name comparison facts across five samples',
    parse: parseComparisonSamplingTranscript,
  },
];

it.each(parserCases)(
  'validates complete $label evidence without changing answers or verdicts',
  ({ label, question, fixture, name, parse }) => {
    expect(fixture.question).toBe(question);
    const request = {
      samples: 5,
      requestBody: {
        temperature: 0.35,
        top_p: 0.9,
        max_tokens: 600,
        stream: false,
        messages: [
          { role: 'system', content: 'Authorized scenario context' },
          { role: 'user', content: question },
        ],
      },
    };
    const samples = Array.from({ length: 5 }, (_, index) => ({
      sample: index + 1,
      httpStatus: 200,
      responseBody: JSON.stringify({
        choices: [{ message: { content: `${label} answer ${index + 1}` } }],
      }),
      answer: `${label} answer ${index + 1}`,
      passed: true,
    }));
    const summary = { samples: 5, passed: 5, failures: [] };
    const row = (kind: string, value: unknown) =>
      `${label} ${kind}: ${JSON.stringify(value)}`;
    const lines = [
      row('sampling request', request),
      ...samples.map((sample) => row('sample', sample)),
      row('sampling summary', summary),
    ];
    const parseLines = (rows: string[]) => parse(rows.join('\n'));
    const expected = { request: request.requestBody, samples };
    expect(parseLines(lines)).toEqual(expected);

    // Vitest resets console styling before evidence records, but may leave the
    // summary unstyled. JSON-escaped controls inside answers are still evidence.
    const colorize = (line: string) => `\u001b[22m\u001b[39m${line}\u001b[0m`;
    const coloredLines = lines.map((line, index) =>
      index === lines.length - 1 ? line : colorize(line),
    );
    expect(parseLines(coloredLines)).toEqual(expected);
    const styledAnswer = { ...samples[0], answer: '\u001b[32mAnswer\u001b[0m' };
    expect(
      parseLines([
        coloredLines[0],
        colorize(row('sample', styledAnswer)),
        ...coloredLines.slice(2),
      ]),
    ).toEqual({ ...expected, samples: [styledAnswer, ...samples.slice(1)] });
    expect(() => parseLines(coloredLines.slice(1))).toThrow('complete');
    expect(() => parseLines([...coloredLines, coloredLines[1]])).toThrow(
      'complete',
    );

    const other = parserCases.find((candidate) => candidate.label !== label)!;
    const otherLines = lines.map((line) =>
      line.replaceAll(label, other.label).replace(question, other.question),
    );
    expect(parseLines(otherLines)).toBeNull();
    expect(other.parse(lines.join('\n'))).toBeNull();
    expect(parseLines([...otherLines, ...lines])).toEqual(expected);
    expect(parseLines([...lines, ...otherLines])).toEqual(expected);
    expect(
      parseLines(['A filtered fixed-seed test without sampling']),
    ).toBeNull();
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
    expect(() => parseLines([`${label} sample: {broken`, ...lines])).toThrow();
    for (const invalid of [
      { ...samples[0], sample: 2 },
      { ...samples[0], passed: 'true' },
      { ...samples[0], answer: ' ' },
      { ...samples[0], answer: null },
      { ...samples[0], answer: 42 },
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
      { messages: null },
      { messages: [] },
      { messages: [{ role: 'user', content: 'Unrelated question' }] },
      { messages: [{ role: 'user', content: question }] },
      {
        messages: [
          { role: 'assistant', content: 'Wrong role' },
          request.requestBody.messages[1],
        ],
      },
      {
        messages: [
          { role: 'system', content: ' ' },
          request.requestBody.messages[1],
        ],
      },
      {
        messages: [
          { role: 'system', content: 42 },
          request.requestBody.messages[1],
        ],
      },
      {
        messages: [
          request.requestBody.messages[0],
          { role: 'assistant', content: question },
        ],
      },
      {
        messages: [
          ...request.requestBody.messages,
          { role: 'user', content: question },
        ],
      },
      { temperature: 0 },
      { top_p: 1 },
      { max_tokens: 1200 },
      { seed: 42 },
      { stream: true },
      { temperature: undefined },
      { top_p: undefined },
      { max_tokens: undefined },
      { stream: undefined },
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
    for (const invalid of [
      null,
      { ...summary, samples: 4 },
      { ...summary, passed: 4 },
      { ...summary, failures: null },
      {
        ...summary,
        failures: [{ sample: 1, phase: 'factuality', error: 'Failed' }],
      },
    ]) {
      expect(() =>
        parseLines([...lines.slice(0, -1), row('sampling summary', invalid)]),
      ).toThrow('summary');
    }

    for (const phase of ['inference', 'response-format', 'factuality']) {
      const failure = { sample: 2, phase, error: `Retained ${phase} failure` };
      const failed = {
        ...samples[1],
        passed: false,
        answer: phase === 'factuality' ? samples[1].answer : null,
        httpStatus: phase === 'inference' ? undefined : 200,
        responseBody:
          phase === 'inference' ? undefined : samples[1].responseBody,
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
      // Corrupt a failed sample independently of its summary. Neither a missing
      // answer nor an invalid failure record can be treated as a factual result.
      for (const invalid of [
        { ...failed, answer: undefined },
        { ...failed, answer: 42 },
        { ...failed, failure: { ...failure, sample: 3 } },
        { ...failed, failure: { ...failure, phase: 'unknown' } },
        { ...failed, failure: { ...failure, error: ' ' } },
        ...(phase === 'factuality' ? [{ ...failed, answer: null }] : []),
      ]) {
        expect(() =>
          parseLines(
            failedLines.map((line, index) =>
              index === 2 ? row('sample', invalid) : line,
            ),
          ),
        ).toThrow();
      }
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
  },
);
