import { expect, it, vi } from 'vitest';
import { evaluateModelRunSemantics } from '../../scripts/support-semantic-runs.mjs';
import { evaluateSemanticTranscript } from '../../scripts/support-semantic.mjs';

vi.mock('../../scripts/support-semantic.mjs', () => ({
  evaluateSemanticTranscript: vi.fn(),
}));

it('scores every executed sampling scenario separately and preserves failures without abandoning other evidence', () => {
  const transcript = '/reports/mixed.log';
  const expectedCalls = [
    [transcript, '/reports/mixed.semantic.json', 'case-pack'],
    [transcript, '/reports/mixed.comparison.semantic.json', 'comparison'],
  ];
  const reportFor = (scenario: string, passed = true) => ({
    scenario,
    factualSamplesPassed: passed,
  });
  const evaluate = vi.mocked(evaluateSemanticTranscript);
  // Only orchestration is mocked here; parser/scorer isolation has its own tests.
  // Do not load Python, Qwen, or real report files in the default suite.
  try {
    for (const included of [
      [],
      ['case-pack'],
      ['comparison'],
      ['case-pack', 'comparison'],
    ]) {
      evaluate.mockReset();
      evaluate.mockImplementation(
        (_source, _destination, scenario = 'case-pack') =>
          included.includes(scenario) ? reportFor(scenario) : null,
      );
      const outcome = evaluateModelRunSemantics(transcript, 0);
      expect(evaluate.mock.calls).toEqual(expectedCalls);
      expect(outcome.exitCode).toBe(0);
      expect(outcome.errors).toEqual([]);
      expect(outcome.reports).toEqual(
        included.map((scenario) => ({
          scenario,
          reportPath:
            scenario === 'case-pack'
              ? '/reports/mixed.semantic.json'
              : '/reports/mixed.comparison.semantic.json',
          report: reportFor(scenario),
        })),
      );
    }

    for (const failingScenario of ['case-pack', 'comparison']) {
      for (const testExitCode of [0, 7]) {
        evaluate.mockReset();
        evaluate.mockImplementation(
          (_source, _destination, scenario = 'case-pack') =>
            reportFor(scenario, scenario !== failingScenario),
        );
        const factualFailure = evaluateModelRunSemantics(
          transcript,
          testExitCode,
        );
        expect(evaluate.mock.calls).toEqual(expectedCalls);
        expect(factualFailure.exitCode).toBe(testExitCode || 1);
        expect(factualFailure.errors).toEqual([]);
        expect(factualFailure.reports).toHaveLength(2);
        expect(
          factualFailure.reports.find(
            (row) => row.scenario === failingScenario,
          )!.report,
        ).toEqual(reportFor(failingScenario, false));

        evaluate.mockReset();
        const error = new Error('Scoring failed or report already exists');
        evaluate.mockImplementation(
          (_source, _destination, scenario = 'case-pack') => {
            if (scenario === failingScenario) throw error;
            return reportFor(scenario);
          },
        );
        const runtimeFailure = evaluateModelRunSemantics(
          transcript,
          testExitCode,
        );
        expect(evaluate.mock.calls).toEqual(expectedCalls);
        expect(runtimeFailure.exitCode).toBe(testExitCode || 1);
        expect(runtimeFailure.errors).toEqual([
          { scenario: failingScenario, error },
        ]);
        expect(runtimeFailure.reports).toHaveLength(1);
        expect(runtimeFailure.reports[0].scenario).not.toBe(failingScenario);
      }
    }
    // Successful or absent semantic results must not erase a Vitest failure.
    for (const response of [reportFor('passing-scenario'), null]) {
      evaluate.mockReset();
      evaluate.mockReturnValue(response);
      expect(evaluateModelRunSemantics(transcript, 7).exitCode).toBe(7);
      expect(evaluate.mock.calls).toEqual(expectedCalls);
    }
    evaluate.mockReset();
    const first = new Error('Invalid case-pack transcript');
    const second = new Error('Invalid comparison transcript');
    evaluate.mockImplementation(
      (_source, _destination, scenario = 'case-pack') => {
        throw scenario === 'case-pack' ? first : second;
      },
    );
    expect(evaluateModelRunSemantics(transcript, 0)).toEqual({
      exitCode: 1,
      reports: [],
      errors: [
        { scenario: 'case-pack', error: first },
        { scenario: 'comparison', error: second },
      ],
    });
    expect(evaluate.mock.calls).toEqual(expectedCalls);
    evaluate.mockClear();
    for (const invalid of ['', '/reports/run.json']) {
      expect(() => evaluateModelRunSemantics(invalid, 0)).toThrow('transcript');
    }
    expect(evaluate).not.toHaveBeenCalled();
  } finally {
    vi.resetAllMocks();
  }
});
