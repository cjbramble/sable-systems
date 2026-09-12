// Run the real launchers/process cleanup, substituting only Qwen, Vitest and HTTP.
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';

const childPath = fileURLToPath(new URL('./child.mjs', import.meta.url));
const scenario = process.env.LAUNCHER_TEST_CASE;
const send = (message) => process.send?.(message);
const originalSpawn = childProcess.spawn;
let spawnedModel = false;
let releaseModel;
const modelReady = new Promise((resolve) => {
  releaseModel = resolve;
});
let releaseReadiness;
const readiness = new Promise((resolve) => {
  releaseReadiness = resolve;
});
process.on('message', (message) => {
  if (message === 'release-readiness') releaseReadiness();
});
process.channel?.unref();

childProcess.spawn = (command, args, options) => {
  const role =
    command === 'launcher-test-model'
      ? 'model'
      : command === 'npm'
        ? 'web-wrapper'
        : 'vitest';
  send({ event: 'spawn-request', role, command, args });
  if (role === 'model') spawnedModel = true;
  const failSpawn =
    scenario === 'dev-web-spawn-failure'
      ? role === 'web-wrapper'
      : scenario.endsWith('spawn-failure') && role === 'model';
  const keepNpm = role === 'web-wrapper';
  const child =
    keepNpm || failSpawn
      ? originalSpawn(
          failSpawn ? '/nonexistent/launcher-test-model' : command,
          args,
          options,
        )
      : originalSpawn(process.execPath, [childPath, role], {
          ...options,
          stdio: [
            ...(typeof options.stdio === 'string'
              ? Array(3).fill(options.stdio)
              : options.stdio),
            'ipc',
          ],
        });
  send({ event: 'spawned', role, pid: child.pid });
  child.on('message', (message) => {
    send(message);
    if (message.event === 'ready' && message.role === 'model') releaseModel();
  });
  child.on('exit', (code, signal) =>
    send({ event: 'child-exit', role, pid: child.pid, code, signal }),
  );
  return child;
};
syncBuiltinESMExports();

function pendingUntilAbort(signal) {
  signal.throwIfAborted();
  return new Promise((_, reject) => {
    const keepalive = setInterval(() => {}, 1000);
    signal.addEventListener(
      'abort',
      () => {
        clearInterval(keepalive);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

globalThis.fetch = async (_url, options) => {
  if (scenario === 'test-borrowed')
    return Response.json({ data: [{ id: 'customer-support-local' }] });
  if (scenario === 'test-interrupt-probe') {
    send({ event: 'readiness-poll' });
    return pendingUntilAbort(options.signal);
  }
  if (scenario.startsWith('test-') && !spawnedModel)
    return new Response('', { status: 503 });
  await modelReady;
  send({ event: 'readiness-poll' });
  if (scenario.endsWith('late-readiness')) {
    // Deliberately resolve successfully even after abort to check the spawn guard.
    const keepalive = setInterval(() => {}, 1000);
    try {
      await readiness;
    } finally {
      clearInterval(keepalive);
    }
  } else if (scenario.endsWith('interrupt-loading')) {
    return pendingUntilAbort(options.signal);
  } else if (scenario.endsWith('timeout')) {
    // Advance only the startup deadline; no three-minute delay or live socket.
    const now = Date.now();
    Date.now = () => now + 180_001;
    return new Response('', { status: 503 });
  }
  return Response.json({ data: [{ id: 'customer-support-local' }] });
};
