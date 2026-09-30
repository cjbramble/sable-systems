import { createProcessScope, exitStatus } from './lib/process-scope.mjs';
import { loadLocalEnvironment } from './lib/environment.mjs';
import {
  getSupportModelConfig,
  supportModelHeaders,
} from '../lib/support-model-config.mjs';

const scope = createProcessScope({ signalCodes: { SIGINT: 0, SIGTERM: 0 } });

try {
  loadLocalEnvironment();
  const config = getSupportModelConfig(process.env);
  supportModelHeaders(config);
  console.log(
    `Using OpenRouter model ${config.model}. Starting COV-E at http://127.0.0.1:8016…`,
  );
  scope.signal.throwIfAborted();
  const web = scope.start('npm', ['run', 'dev:web'], { stdio: 'inherit' });
  // Exit may precede pipe closure when the npm wrapper leaves descendants alive.
  const result = await web.exited;
  if (result.error)
    console.error(`Could not start the web app: ${result.error.message}`);
  // Any unrequested web exit is failure; npm can normalize a signal to code 0.
  await scope.stop(exitStatus(result) || 1);
} catch (error) {
  if (!scope.stopping) {
    console.error(error instanceof Error ? error.message : error);
    await scope.stop(1);
  }
} finally {
  await scope.stop();
  scope.dispose();
  process.exitCode = scope.exitCode;
}
