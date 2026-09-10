import { listSemanticScenarios } from './semantic-results.mjs';
import { evaluateSemanticTranscript } from './support-semantic.mjs';

export function evaluateModelRunSemantics(transcriptPath, testExitCode = 0) {
  if (typeof transcriptPath !== 'string' || !transcriptPath.endsWith('.log'))
    throw new Error('Expected a model-run .log transcript path');
  const prefix = transcriptPath.slice(0, -4);
  const reports = [];
  const errors = [];
  let exitCode = testExitCode;
  for (const scenario of listSemanticScenarios()) {
    // Preserve the existing case-pack sidecar name; other scenarios are distinct.
    const suffix = scenario === 'case-pack' ? '' : `.${scenario}`;
    const reportPath = `${prefix}${suffix}.semantic.json`;
    try {
      // The evaluator returns null before loading Python when a scenario is absent.
      const report = evaluateSemanticTranscript(
        transcriptPath,
        reportPath,
        scenario,
      );
      if (report === null) continue;
      reports.push({ scenario, reportPath, report });
      if (report.factualSamplesPassed === false) exitCode ||= 1;
    } catch (error) {
      // Keep the failure and continue once to the next scenario, never retry this one.
      errors.push({ scenario, error });
      exitCode ||= 1;
    }
  }
  return { exitCode, reports, errors };
}
