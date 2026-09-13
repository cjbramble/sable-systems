import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  localModelIsReady,
  modelLaunch,
  waitForModel,
} from './lib/local-model.mjs';
import { createProcessScope, exitStatus } from './lib/process-scope.mjs';

const scope = createProcessScope({ signalCodes: { SIGINT: 0, SIGTERM: 0 } });
const logPath = resolve('reports/server-logs/llama-server.log');
let logFile;

try {
  const launch = modelLaunch();
  if (!existsSync(launch.path))
    throw new Error(`Missing model file: ${launch.path}`);
  mkdirSync(dirname(logPath), { recursive: true });
  logFile = openSync(logPath, 'a');
  console.log('Starting the private Qwen support model on 127.0.0.1:8017…');
  const model = scope.start(launch.executable, launch.args, {
    stdio: ['ignore', logFile, logFile],
  });
  void model.exited.then((result) => {
    if (scope.stopping) return;
    console.error(
      result.error
        ? `Could not start llama-server: ${result.error.message}`
        : `llama-server stopped unexpectedly. See ${logPath}`,
    );
    return scope.stop(exitStatus(result) || 1);
  });
  await waitForModel(localModelIsReady, scope.signal);
  scope.signal.throwIfAborted();
  console.log('Local model ready. Starting COV-E at http://127.0.0.1:8016…');
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
  if (logFile !== undefined) closeSync(logFile);
  scope.dispose();
  process.exitCode = scope.exitCode;
}
