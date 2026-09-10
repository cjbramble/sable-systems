import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { expect, it, vi } from 'vitest';
import { evaluateSemanticTranscript } from '../../scripts/support-semantic.mjs';
import casePack from '../fixtures/semantic/case-pack.json';
import comparison from '../fixtures/semantic/comparison.json';
import { createSemanticEvaluatorReport } from '../fixtures/semantic/evaluator';

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}));
vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const bytes = (fixture: typeof casePack) => JSON.stringify(fixture) + '\n';
const semanticReportFor = (
  fixture: typeof casePack,
  samples: { sample: number; answer: string | null }[],
) => createSemanticEvaluatorReport(fixture, samples, hash(bytes(fixture)));

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
      const response = semanticReportFor(fixture, samples);
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

it('keeps unanswered inference failures unscored and failing while scoring only available answers with their original IDs', () => {
  const quiet = vi.spyOn(console, 'info').mockImplementation(() => {});
  try {
    for (const { key, label, fixture } of [
      { key: 'case-pack', label: 'Case-pack', fixture: casePack },
      { key: 'comparison', label: 'Comparison', fixture: comparison },
    ]) {
      for (const unanswered of [
        [2, 4],
        [1, 2, 3, 4, 5],
      ]) {
        const request = {
          temperature: 0.35,
          top_p: 0.9,
          max_tokens: 600,
          stream: false,
          messages: [
            { role: 'system', content: 'Scenario-specific authorized context' },
            { role: 'user', content: fixture.question },
          ],
        };
        const samples = Array.from({ length: 5 }, (_, index) => {
          const sample = index + 1;
          return unanswered.includes(sample)
            ? {
                sample,
                answer: null,
                passed: false,
                failure: {
                  sample,
                  phase: 'inference',
                  error: `Request ${sample} timed out`,
                },
              }
            : { sample, answer: `${key} answer ${sample}`, passed: true };
        });
        const transcript = [
          `${label} sampling request: ${JSON.stringify({ samples: 5, requestBody: request })}`,
          ...samples.map(
            (sample) => `${label} sample: ${JSON.stringify(sample)}`,
          ),
          `${label} sampling summary: ${JSON.stringify({
            samples: 5,
            passed: 5 - unanswered.length,
            failures: samples
              .filter((sample) => !sample.passed)
              .map((sample) => sample.failure),
          })}`,
        ].join('\n');
        vi.mocked(readFileSync).mockImplementation((path) => {
          if (String(path).endsWith(`/${key}.json`)) return bytes(fixture);
          if (path === 'unanswered.log') return transcript;
          throw new Error(`Unexpected read: ${String(path)}`);
        });
        // Construct the evaluator's result from the expected IDs, not its input,
        // so accidentally embedded failures or renumbered answers cannot pass.
        const answered = samples.filter(
          (sample) => !unanswered.includes(sample.sample),
        );
        const response = semanticReportFor(fixture, answered);
        vi.mocked(spawnSync)
          .mockReset()
          .mockReturnValue({
            status: 0,
            stdout: JSON.stringify(response),
            stderr: '',
            pid: 1,
            signal: null,
            output: [],
          });
        vi.mocked(writeFileSync).mockClear();
        const report = evaluateSemanticTranscript(
          'unanswered.log',
          'unanswered.json',
          key,
        );

        expect(spawnSync).toHaveBeenCalledTimes(1);
        const [, args, options] = vi.mocked(spawnSync).mock.calls[0];
        expect(args).toEqual([
          expect.stringMatching(/\/semantic\/evaluate\.py$/),
          '--scenario',
          key,
        ]);
        expect(JSON.parse(options!.input as string)).toEqual({
          samples: answered,
        });
        expect(report!.samples).toEqual(response.samples);
        expect(
          report!.samples.map((sample: { sample: number }) => sample.sample),
        ).toEqual(unanswered.length === 5 ? [] : [1, 3, 5]);
        expect(report!.pairwiseSimilarity).toEqual(response.pairwiseSimilarity);
        expect(report!.factualSamplesPassed).toBe(false);
        expect(report!.factualVerdicts).toEqual(
          samples.map(({ sample, passed, failure }) => ({
            sample,
            passed,
            failure,
          })),
        );
        expect(report!.unscored).toEqual(
          unanswered.map((sample) => ({
            sample,
            reason: 'No model answer to embed',
            failure: samples[sample - 1].failure,
          })),
        );
        expect(report).toMatchObject({
          request,
          sourceSha256: hash(transcript),
          fixtureSha256: hash(bytes(fixture)),
          calibration: response.calibration,
        });
        expect(writeFileSync).toHaveBeenCalledExactlyOnceWith(
          'unanswered.json',
          JSON.stringify(report, null, 2) + '\n',
          { flag: 'wx' },
        );
      }
    }
  } finally {
    quiet.mockRestore();
    vi.resetAllMocks();
  }
});

it('rejects evaluator process failures and malformed output without creating or announcing a semantic report', () => {
  const quiet = vi.spyOn(console, 'info').mockImplementation(() => {});
  try {
    for (const { key, label, fixture } of [
      { key: 'case-pack', label: 'Case-pack', fixture: casePack },
      { key: 'comparison', label: 'Comparison', fixture: comparison },
    ]) {
      const samples = Array.from({ length: 5 }, (_, index) => ({
        sample: index + 1,
        answer: `${key} answer ${index + 1}`,
        passed: true,
      }));
      const requestBody = {
        temperature: 0.35,
        top_p: 0.9,
        max_tokens: 600,
        stream: false,
        messages: [
          { role: 'system', content: 'Scenario-specific authorized context' },
          { role: 'user', content: fixture.question },
        ],
      };
      const transcript = [
        `${label} sampling request: ${JSON.stringify({ samples: 5, requestBody })}`,
        ...samples.map(
          (sample) => `${label} sample: ${JSON.stringify(sample)}`,
        ),
        `${label} sampling summary: ${JSON.stringify({ samples: 5, passed: 5, failures: [] })}`,
      ].join('\n');
      vi.mocked(readFileSync).mockImplementation((path) => {
        if (String(path).endsWith(`/${key}.json`)) return bytes(fixture);
        if (path === 'evaluator.log') return transcript;
        throw new Error(`Unexpected read: ${String(path)}`);
      });
      const response = semanticReportFor(fixture, samples);
      const success: SpawnSyncReturns<string> = {
        status: 0,
        stdout: JSON.stringify(response),
        stderr: '',
        pid: 1,
        signal: null,
        output: [],
      };
      const evaluate = () =>
        evaluateSemanticTranscript('evaluator.log', 'evaluator.json', key);
      // Positive control: the same input writes a report when evaluation is valid.
      vi.mocked(spawnSync).mockReturnValue(success);
      expect(evaluate()).toMatchObject({
        samples: response.samples,
        factualSamplesPassed: true,
      });
      expect(writeFileSync).toHaveBeenLastCalledWith(
        'evaluator.json',
        expect.any(String),
        { flag: 'wx' },
      );

      const failures: {
        name: string;
        result: Partial<SpawnSyncReturns<string>>;
        expectedError: string | typeof SyntaxError;
      }[] = [
        {
          name: 'missing executable',
          result: {
            status: null,
            stdout: '',
            error: new Error('spawnSync python ENOENT'),
          },
          expectedError:
            'Local Sentence Transformers evaluation failed. Run npm run setup:semantic. spawnSync python ENOENT',
        },
        {
          name: 'timeout',
          result: {
            status: null,
            signal: 'SIGTERM',
            stdout: '',
            error: new Error('spawnSync python ETIMEDOUT'),
          },
          expectedError:
            'Local Sentence Transformers evaluation failed. Run npm run setup:semantic. spawnSync python ETIMEDOUT',
        },
        // Valid-looking stdout cannot rescue a failed or terminated subprocess.
        {
          name: 'nonzero exit',
          result: { status: 2, stderr: 'Model receipt verification failed' },
          expectedError:
            'Local Sentence Transformers evaluation failed. Run npm run setup:semantic. Model receipt verification failed',
        },
        {
          name: 'signal termination',
          result: { status: null, signal: 'SIGTERM' },
          expectedError: 'Local Sentence Transformers evaluation failed',
        },
        {
          name: 'empty stdout',
          result: { stdout: '' },
          expectedError: SyntaxError,
        },
        {
          name: 'truncated JSON',
          result: { stdout: '{"schemaVersion":' },
          expectedError: SyntaxError,
        },
        {
          name: 'null report',
          result: { stdout: 'null' },
          expectedError: 'Invalid semantic report identity',
        },
        {
          name: 'empty report',
          result: { stdout: '{}' },
          expectedError: 'Invalid semantic report identity',
        },
        {
          name: 'missing sample scores',
          result: {
            stdout: JSON.stringify({
              ...response,
              samples: response.samples.slice(1),
            }),
          },
          expectedError: 'Semantic report omitted or added sample scores',
        },
        {
          name: 'invalid score',
          result: {
            stdout: JSON.stringify({
              ...response,
              samples: response.samples.map((sample, index) =>
                index === 0 ? { ...sample, score: 2 } : sample,
              ),
            }),
          },
          expectedError:
            'Semantic report contains an invalid or mismatched score',
        },
        {
          name: 'missing pairwise evidence',
          result: {
            stdout: JSON.stringify({ ...response, pairwiseSimilarity: [] }),
          },
          expectedError: 'Incomplete or invalid pairwise similarity results',
        },
      ];
      for (const { name, result, expectedError } of failures) {
        vi.mocked(spawnSync)
          .mockReset()
          .mockReturnValue({ ...success, ...result });
        vi.mocked(mkdirSync).mockClear();
        vi.mocked(writeFileSync).mockClear();
        quiet.mockClear();
        expect(evaluate, `${key}: ${name}`).toThrow(expectedError);
        expect(spawnSync).toHaveBeenCalledTimes(1);
        const [, , options] = vi.mocked(spawnSync).mock.calls[0];
        expect(JSON.parse(options!.input as string)).toEqual({ samples });
        expect(options!.timeout).toBe(60_000);
        expect(mkdirSync).not.toHaveBeenCalled();
        expect(writeFileSync).not.toHaveBeenCalled();
        expect(quiet).not.toHaveBeenCalled();
      }
    }
  } finally {
    quiet.mockRestore();
    vi.resetAllMocks();
  }
});
