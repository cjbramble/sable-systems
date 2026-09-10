import { parseArgs } from 'node:util';
import { evaluateSemanticTranscript } from './support-semantic.mjs';

try {
  const { values } = parseArgs({
    options: {
      transcript: { type: 'string' },
      scenario: { type: 'string', default: 'case-pack' },
    },
    allowPositionals: false,
  });
  const report = evaluateSemanticTranscript(
    values.transcript,
    undefined,
    values.scenario,
  );
  if (!report)
    throw new Error(
      `The transcript contains no ${values.scenario} sampling run`,
    );
  if (report.factualSamplesPassed === false) process.exitCode = 1;
} catch (error) {
  console.error(error);
  console.error(
    'Usage: npm run test:semantic -- [--scenario case-pack|comparison] [--transcript path/to/run.log]',
  );
  process.exitCode = 1;
}
