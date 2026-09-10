import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { expect, it, vi } from 'vitest';
import { evaluateSemanticTranscript } from '../../scripts/support-semantic.mjs';
import casePack from '../fixtures/semantic/case-pack.json';
import comparison from '../fixtures/semantic/comparison.json';
import manifest from '../../scripts/semantic/model.json';

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}));
vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));

const hash = (text: string) => createHash('sha256').update(text).digest('hex');

it('scores only the selected scenario and rejects mismatched reference evidence without changing factual verdicts', () => {
  const batches = [
    { key: 'case-pack', label: 'Case-pack', fixture: casePack },
    { key: 'comparison', label: 'Comparison', fixture: comparison },
  ].map((scenario) => ({
    ...scenario,
    request: {
      temperature: 0.35,
      top_p: 0.9,
      max_tokens: 600,
      stream: false,
      messages: [
        { role: 'system', content: 'Scenario-specific authorized context' },
        { role: 'user', content: scenario.fixture.question },
      ],
    },
    samples: Array.from({ length: 5 }, (_, i) => ({
      sample: i + 1,
      answer: `${scenario.key} answer ${i + 1}`,
      passed: true,
    })),
  }));
  const transcript = batches
    .flatMap(({ label, request, samples }) => [
      `${label} sampling request: ${JSON.stringify({ samples: 5, requestBody: request })}`,
      ...samples.map((sample) => `${label} sample: ${JSON.stringify(sample)}`),
      `${label} sampling summary: ${JSON.stringify({ samples: 5, passed: 5, failures: [] })}`,
    ])
    .join('\n');
  const bytes = (fixture: typeof casePack) => JSON.stringify(fixture) + '\n';
  let retainedTranscript = transcript;
  vi.mocked(readFileSync).mockImplementation((path) => {
    if (String(path).endsWith('/case-pack.json')) return bytes(casePack);
    if (String(path).endsWith('/comparison.json')) return bytes(comparison);
    if (path === 'mixed.log') return retainedTranscript;
    throw new Error(`Unexpected read: ${String(path)}`);
  });
  const quiet = vi.spyOn(console, 'info').mockImplementation(() => {});
  try {
    for (const { key, label, request, samples, fixture } of batches) {
      const response = {
        schemaVersion: 1,
        scenario: fixture.scenario,
        policy: { mode: 'advisory' },
        model: { id: manifest.id, revision: manifest.revision },
        fixtureSha256: hash(bytes(fixture)),
        samples: samples.map(({ sample, answer }) => ({
          sample,
          answer,
          score: 0.9,
          referenceScores: [0.9, 0.8],
          chunks: 1,
        })),
        calibration: {
          minimumCorrectScore: 0.7,
          maximumIncorrectScore: 0.99,
          status: 'overlap',
          examples: fixture.examples.map((example) => ({
            ...example,
            score: 0.8,
          })),
        },
        pairwiseSimilarity: samples.map(() => samples.map(() => 0.9)),
      };
      const respond = (report: typeof response) =>
        vi.mocked(spawnSync).mockReturnValue({
          status: 0,
          stdout: JSON.stringify(report),
          stderr: '',
          pid: 1,
          signal: null,
          output: [],
        });
      // Omission must preserve the existing case-pack default.
      const scenario = key === 'case-pack' ? undefined : key;
      respond(response);
      const report = evaluateSemanticTranscript(
        'mixed.log',
        `${key}.json`,
        scenario,
      );
      const [, args, options] = vi.mocked(spawnSync).mock.calls.at(-1)!;
      expect(args).toEqual([
        expect.stringMatching(/\/semantic\/evaluate\.py$/),
        '--scenario',
        key,
      ]);
      expect(JSON.parse(options!.input as string)).toEqual({ samples });
      expect(options!.env).toMatchObject({
        HF_HUB_OFFLINE: '1',
        TRANSFORMERS_OFFLINE: '1',
      });
      expect(report).toMatchObject({
        scenario: fixture.scenario,
        request,
        sourceSha256: hash(transcript),
        fixtureSha256: hash(bytes(fixture)),
        factualSamplesPassed: true,
        unscored: [],
      });
      expect(writeFileSync).toHaveBeenLastCalledWith(
        `${key}.json`,
        JSON.stringify(report, null, 2) + '\n',
        { flag: 'wx' },
      );

      const other = key === 'comparison' ? casePack : comparison;
      const wrongIdentity = { ...response, scenario: other.scenario };
      const wrongHash = { ...response, fixtureSha256: hash(bytes(other)) };
      const wrongExamples = structuredClone(response);
      wrongExamples.calibration.examples[0] = {
        ...other.examples[0],
        score: 0.8,
      };
      for (const invalid of [wrongIdentity, wrongHash, wrongExamples]) {
        respond(invalid);
        vi.mocked(writeFileSync).mockClear();
        expect(() =>
          evaluateSemanticTranscript('mixed.log', 'invalid.json', scenario),
        ).toThrow();
        expect(writeFileSync).not.toHaveBeenCalled();
      }
      respond(response);
      const failure = { sample: 2, phase: 'factuality', error: 'Wrong price' };
      retainedTranscript = transcript
        .replace(
          `${label} sample: ${JSON.stringify(samples[1])}`,
          `${label} sample: ${JSON.stringify({ ...samples[1], passed: false, failure })}`,
        )
        .replace(
          `${label} sampling summary: ${JSON.stringify({ samples: 5, passed: 5, failures: [] })}`,
          `${label} sampling summary: ${JSON.stringify({ samples: 5, passed: 4, failures: [failure] })}`,
        );
      const failedReport = evaluateSemanticTranscript(
        'mixed.log',
        'failed.json',
        scenario,
      );
      expect(failedReport!.factualSamplesPassed).toBe(false);
      expect(failedReport!.factualVerdicts[1]).toEqual({
        sample: 2,
        passed: false,
        failure,
      });
      expect(failedReport!.samples).toEqual(response.samples);
      retainedTranscript = transcript;
    }
    const calls = vi.mocked(spawnSync).mock.calls.length;
    for (const unknown of ['../case-pack', '__proto__', 'toString']) {
      expect(() =>
        evaluateSemanticTranscript('mixed.log', undefined, unknown),
      ).toThrow('Unknown');
    }
    retainedTranscript =
      'A filtered test without the selected sampling scenario';
    expect(
      evaluateSemanticTranscript('mixed.log', undefined, 'comparison'),
    ).toBeNull();
    expect(vi.mocked(spawnSync).mock.calls).toHaveLength(calls);
  } finally {
    quiet.mockRestore();
    vi.resetAllMocks();
  }
});
