import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { evaluateSemanticTranscript } from '../../scripts/support-semantic.mjs';
import { evaluateModelRunSemantics } from '../../scripts/support-semantic-runs.mjs';
import casePack from '../fixtures/semantic/case-pack.json';
import comparison from '../fixtures/semantic/comparison.json';
import { createSemanticEvaluatorReport } from '../fixtures/semantic/evaluator';

vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));

const scenarios = [
  { key: 'case-pack', label: 'Case-pack', fixture: casePack },
  { key: 'comparison', label: 'Comparison', fixture: comparison },
] as const;
const hash = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex');

function createScenarioEvidence({
  key,
  label,
  fixture,
}: (typeof scenarios)[number]) {
  const samples = Array.from({ length: 5 }, (_, index) => ({
    sample: index + 1,
    answer: fixture.references[0],
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
    ...samples.map((sample) => `${label} sample: ${JSON.stringify(sample)}`),
    `${label} sampling summary: ${JSON.stringify({ samples: 5, passed: 5, failures: [] })}`,
  ].join('\n');
  const response = createSemanticEvaluatorReport(
    fixture,
    samples,
    hash(
      readFileSync(
        new URL(`../fixtures/semantic/${key}.json`, import.meta.url),
      ),
    ),
  );
  return { samples, requestBody, transcript, response };
}

it('propagates report-write failures without overwriting existing evidence or announcing a saved report', () => {
  const directory = mkdtempSync(join(tmpdir(), 'support-semantic-report-'));
  const quiet = vi.spyOn(console, 'info').mockImplementation(() => {});
  try {
    for (const scenario of scenarios) {
      const { key } = scenario;
      const scenarioDirectory = join(directory, key);
      mkdirSync(scenarioDirectory);
      const source = join(scenarioDirectory, 'sampling.log');
      const destination = join(scenarioDirectory, 'sampling.semantic.json');
      const blockedParent = join(scenarioDirectory, 'not-a-directory');
      const blocker = 'Preserve this file. It cannot be a report directory.\n';
      writeFileSync(blockedParent, blocker, { flag: 'wx' });
      const { transcript, response } = createScenarioEvidence(scenario);
      writeFileSync(source, transcript, { flag: 'wx' });
      const respond = () =>
        vi
          .mocked(spawnSync)
          .mockReset()
          .mockReturnValue({
            status: 0,
            stdout: JSON.stringify(response),
            stderr: '',
            pid: 1,
            signal: null,
            output: [],
          });

      // Establish an actual saved report through the production writer first.
      respond();
      const report = evaluateSemanticTranscript(source, destination, key);
      const original = readFileSync(destination, 'utf8');
      expect(original).toBe(JSON.stringify(report, null, 2) + '\n');
      expect(report).toMatchObject({
        samples: response.samples,
        factualSamplesPassed: true,
      });
      expect(quiet).toHaveBeenCalledWith(
        `Sentence Transformers report: ${destination}`,
      );
      const entries = () =>
        readdirSync(scenarioDirectory, {
          recursive: true,
          encoding: 'utf8',
        }).sort((left, right) => left.localeCompare(right));
      const originalEntries = entries();

      // A different valid result makes an accidental overwrite observable.
      response.samples[0].score = 0.5;
      for (const { path, code, syscall } of [
        { path: destination, code: 'EEXIST', syscall: 'open' },
        {
          path: join(blockedParent, 'nested', 'report.json'),
          code: 'ENOTDIR',
          syscall: 'mkdir',
        },
      ]) {
        respond();
        quiet.mockClear();
        let failure: unknown;
        try {
          evaluateSemanticTranscript(source, path, key);
        } catch (error) {
          failure = error;
        }
        expect(failure, `${key}: ${code}`).toMatchObject({ code, syscall });
        expect(spawnSync).toHaveBeenCalledTimes(1);
        expect(quiet).not.toHaveBeenCalled();
        expect(readFileSync(destination, 'utf8')).toBe(original);
        expect(readFileSync(source, 'utf8')).toBe(transcript);
        expect(readFileSync(blockedParent, 'utf8')).toBe(blocker);
        expect(entries()).toEqual(originalEntries);
      }
    }
  } finally {
    quiet.mockRestore();
    vi.resetAllMocks();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('retains the other scenario report after a write collision while preserving the overall failure', () => {
  const directory = mkdtempSync(join(tmpdir(), 'support-semantic-mixed-'));
  const quiet = vi.spyOn(console, 'info').mockImplementation(() => {});
  try {
    for (const failedScenario of scenarios) {
      for (const originalExitCode of [0, 7]) {
        const runDirectory = join(
          directory,
          `${failedScenario.key}-${originalExitCode}`,
        );
        mkdirSync(runDirectory);
        const source = join(runDirectory, 'mixed.log');
        const destinations = {
          'case-pack': join(runDirectory, 'mixed.semantic.json'),
          comparison: join(runDirectory, 'mixed.comparison.semantic.json'),
        };
        const batches = scenarios.map((scenario) => ({
          ...scenario,
          ...createScenarioEvidence(scenario),
        }));
        const transcript = batches.map((batch) => batch.transcript).join('\n');
        writeFileSync(source, transcript, { flag: 'wx' });
        vi.mocked(spawnSync)
          .mockReset()
          .mockImplementation((_command, args) => {
            const batch = batches.find(
              (candidate) => candidate.key === args?.[2],
            );
            if (!batch)
              throw new Error(
                `Unexpected evaluator arguments: ${JSON.stringify(args)}`,
              );
            return {
              status: 0,
              stdout: JSON.stringify(batch.response),
              stderr: '',
              pid: 1,
              signal: null,
              output: [],
            };
          });

        const existingPath = destinations[failedScenario.key];
        evaluateSemanticTranscript(source, existingPath, failedScenario.key);
        const originalReport = readFileSync(existingPath, 'utf8');
        const failedBatch = batches.find(
          (batch) => batch.key === failedScenario.key,
        )!;
        // Re-evaluation would save different bytes if exclusive writes regressed.
        failedBatch.response.samples[0].score = 0.5;
        const successfulBatch = batches.find(
          (batch) => batch.key !== failedScenario.key,
        )!;
        const savedPath = destinations[successfulBatch.key];
        vi.mocked(spawnSync).mockClear();
        quiet.mockClear();

        const outcome = evaluateModelRunSemantics(source, originalExitCode);

        expect(outcome.exitCode).toBe(originalExitCode || 1);
        expect(outcome.errors).toEqual([
          {
            scenario: failedScenario.key,
            error: expect.objectContaining({
              code: 'EEXIST',
              syscall: 'open',
              path: existingPath,
            }),
          },
        ]);
        expect(outcome.reports).toHaveLength(1);
        expect(outcome.reports[0]).toMatchObject({
          scenario: successfulBatch.key,
          reportPath: savedPath,
          report: {
            scenario: successfulBatch.fixture.scenario,
            fixtureSha256: successfulBatch.response.fixtureSha256,
            sourceTranscript: source,
            sourceSha256: hash(transcript),
            request: successfulBatch.requestBody,
            samples: successfulBatch.response.samples,
            factualSamplesPassed: true,
            factualVerdicts: successfulBatch.samples.map(
              ({ sample, passed }) => ({ sample, passed }),
            ),
            unscored: [],
          },
        });
        expect(readFileSync(savedPath, 'utf8')).toBe(
          JSON.stringify(outcome.reports[0].report, null, 2) + '\n',
        );
        expect(readFileSync(existingPath, 'utf8')).toBe(originalReport);
        expect(readFileSync(source, 'utf8')).toBe(transcript);
        expect(
          readdirSync(runDirectory, { encoding: 'utf8' }).sort((left, right) =>
            left.localeCompare(right),
          ),
        ).toEqual([
          'mixed.comparison.semantic.json',
          'mixed.log',
          'mixed.semantic.json',
        ]);

        // Each scenario is attempted once, with isolated answers in registry order.
        expect(spawnSync).toHaveBeenCalledTimes(2);
        for (const [index, batch] of batches.entries()) {
          const [, args, options] = vi.mocked(spawnSync).mock.calls[index];
          expect(args).toEqual([
            expect.stringMatching(/\/semantic\/evaluate\.py$/),
            '--scenario',
            batch.key,
          ]);
          expect(JSON.parse(options!.input as string)).toEqual({
            samples: batch.samples,
          });
        }
        expect(quiet).toHaveBeenCalledTimes(2 + successfulBatch.samples.length);
        expect(quiet.mock.calls[0]).toEqual([
          `Sentence Transformers report: ${savedPath}`,
        ]);
        expect(quiet).not.toHaveBeenCalledWith(
          `Sentence Transformers report: ${existingPath}`,
        );
      }
    }
  } finally {
    quiet.mockRestore();
    vi.resetAllMocks();
    rmSync(directory, { recursive: true, force: true });
  }
});
