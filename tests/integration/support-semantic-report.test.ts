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
import casePack from '../fixtures/semantic/case-pack.json';
import comparison from '../fixtures/semantic/comparison.json';
import { createSemanticEvaluatorReport } from '../fixtures/semantic/evaluator';

vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));

it('propagates report-write failures without overwriting existing evidence or announcing a saved report', () => {
  const directory = mkdtempSync(join(tmpdir(), 'support-semantic-report-'));
  const quiet = vi.spyOn(console, 'info').mockImplementation(() => {});
  try {
    for (const { key, label, fixture } of [
      { key: 'case-pack', label: 'Case-pack', fixture: casePack },
      { key: 'comparison', label: 'Comparison', fixture: comparison },
    ]) {
      const scenarioDirectory = join(directory, key);
      mkdirSync(scenarioDirectory);
      const source = join(scenarioDirectory, 'sampling.log');
      const destination = join(scenarioDirectory, 'sampling.semantic.json');
      const blockedParent = join(scenarioDirectory, 'not-a-directory');
      const blocker = 'Preserve this file. It cannot be a report directory.\n';
      writeFileSync(blockedParent, blocker, { flag: 'wx' });
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
        ...samples.map(
          (sample) => `${label} sample: ${JSON.stringify(sample)}`,
        ),
        `${label} sampling summary: ${JSON.stringify({ samples: 5, passed: 5, failures: [] })}`,
      ].join('\n');
      writeFileSync(source, transcript, { flag: 'wx' });
      const response = createSemanticEvaluatorReport(
        fixture,
        samples,
        createHash('sha256')
          .update(
            readFileSync(
              new URL(`../fixtures/semantic/${key}.json`, import.meta.url),
            ),
          )
          .digest('hex'),
      );
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
