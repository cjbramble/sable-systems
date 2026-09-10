import { evaluateSemanticTranscript } from './support-semantic.mjs';

const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== '--transcript')) {
  console.error(
    'Usage: npm run test:semantic -- [--transcript path/to/run.log]',
  );
  process.exitCode = 1;
} else {
  try {
    const report = evaluateSemanticTranscript(args[1]);
    if (!report)
      throw new Error('The transcript contains no case-pack sampling run');
    if (report.factualSamplesPassed === false) process.exitCode = 1;
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
