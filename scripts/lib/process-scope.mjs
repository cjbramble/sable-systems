import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

// POSIX groups include npm's shell/web descendants even if the wrapper exits first.
function signalOwned(record, signal) {
  if (!record.child.pid) return;
  try {
    if (process.platform === 'win32') record.child.kill(signal);
    else process.kill(-record.child.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

function isRunning(record) {
  if (!record.child.pid) return false;
  if (process.platform === 'win32')
    return record.child.exitCode === null && record.child.signalCode === null;
  try {
    process.kill(-record.child.pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

export function exitStatus({ code, signal, error }) {
  return signal || error ? 1 : (code ?? 1);
}

export function createProcessScope({
  signalCodes = { SIGINT: 130, SIGTERM: 143 },
  graceMs = 3000,
} = {}) {
  const controller = new AbortController();
  const records = new Set();
  let stopping = false;
  let shutdown;
  let exitCode = 0;

  function start(command, args, options = {}) {
    controller.signal.throwIfAborted();
    const child = spawn(command, args, {
      ...options,
      detached: process.platform !== 'win32',
    });
    let error;
    const exited = new Promise((resolve) => {
      child.once('error', (cause) => {
        error = cause;
        resolve({ code: 1, signal: null, error });
      });
      child.once('exit', (code, signal) => resolve({ code, signal, error }));
    });
    const record = { child, closed: false, shutdown: null };
    record.stop = () => (record.shutdown ??= terminate(record));
    const closed = new Promise((resolve) =>
      child.once('close', (code, signal) => {
        record.closed = true;
        if (!isRunning(record)) records.delete(record);
        resolve({ code, signal, error });
      }),
    );
    records.add(record);
    return { child, exited, closed, stop: record.stop };
  }

  async function waitForClosure(record, timeoutMs) {
    const deadline = performance.now() + timeoutMs;
    while (!record.closed || isRunning(record)) {
      if (performance.now() >= deadline) return false;
      await delay(25);
    }
    return true;
  }

  async function terminate(record) {
    signalOwned(record, 'SIGTERM');
    if (await waitForClosure(record, graceMs)) return;
    if (isRunning(record)) signalOwned(record, 'SIGKILL');
    if (!(await waitForClosure(record, 2000)))
      throw new Error(
        `Owned process group ${record.child.pid} did not finish closing after forced termination.`,
      );
  }

  function stop(code = 0) {
    if (!stopping) {
      stopping = true;
      exitCode = code;
      // Mark shutdown terminal before abort callbacks or child events can run.
      shutdown = Promise.resolve()
        .then(async () => {
          const results = await Promise.allSettled(
            [...records].map((record) => record.stop()),
          );
          const failures = results.filter(
            (result) => result.status === 'rejected',
          );
          if (failures.length)
            throw new AggregateError(
              failures.map((result) => result.reason),
              'Owned-process cleanup failed',
            );
        })
        .catch((error) => {
          exitCode ||= 1;
          console.error(error);
        });
      controller.abort();
    }
    return shutdown;
  }

  const handlers = Object.entries(signalCodes).map(([signal, code]) => {
    const handler = () => {
      void stop(code);
    };
    process.on(signal, handler);
    return [signal, handler];
  });

  return {
    start,
    stop,
    signal: controller.signal,
    get stopping() {
      return stopping;
    },
    get exitCode() {
      return exitCode;
    },
    dispose() {
      for (const [signal, handler] of handlers) process.off(signal, handler);
    },
  };
}
