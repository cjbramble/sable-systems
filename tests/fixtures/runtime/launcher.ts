import { spawn } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, onTestFinished } from 'vitest';

type Event = {
  event: string;
  role: string;
  pid?: number;
  code?: number;
  signal?: string;
};
const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
export function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

export function launchFixture(scenario: string) {
  const directory = mkdtempSync(join(tmpdir(), 'support-launcher-'));
  const borrowed =
    scenario === 'test-borrowed'
      ? spawn(process.execPath, [here('./child.mjs'), 'borrowed'], {
          detached: true,
          stdio: 'ignore',
        })
      : null;
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({
      private: true,
      scripts: { 'dev:web': `node ${JSON.stringify(here('./child.mjs'))} web` },
    }),
  );
  const script = scenario.startsWith('dev-')
    ? 'dev-local.mjs'
    : 'test-support-model.mjs';
  const child = spawn(
    process.execPath,
    ['--import', here('./preload.mjs'), here(`../../../scripts/${script}`)],
    {
      cwd: directory,
      detached: true,
      env: {
        ...process.env,
        LLAMA_SERVER: 'launcher-test-model',
        CUSTOMER_SUPPORT_MODEL_PATH: here('./child.mjs'),
        LAUNCHER_TEST_CASE: scenario,
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    },
  );
  const events: Event[] = [];
  let output = '';
  let stdoutLine = '';
  let exit: { code: number | null; signal: NodeJS.Signals | null } | null =
    null;
  child.on('message', (event) => events.push(event as Event));
  child.on('exit', (code, signal) => {
    exit = { code, signal };
  });
  const closed = new Promise<void>((resolve) =>
    child.once('close', () => resolve()),
  );
  child.on('error', (error) => {
    output += error.message;
  });
  child.stdout!.on('data', (chunk) => {
    output += chunk;
    stdoutLine += chunk;
    const lines = stdoutLine.split('\n');
    stdoutLine = lines.pop()!;
    for (const line of lines)
      if (line.startsWith('LAUNCHER_EVENT '))
        events.push(JSON.parse(line.slice(15)));
  });
  child.stderr!.on('data', (chunk) => {
    output += chunk;
  });

  async function waitFor(
    predicate: () => boolean,
    message: string,
    timeout = 7000,
  ) {
    const deadline = performance.now() + timeout;
    while (!predicate() && performance.now() < deadline) await delay(15);
    expect(
      predicate(),
      `${scenario}: ${message}\n${output}\n${JSON.stringify(events)}`,
    ).toBe(true);
  }
  const pids = () => [
    ...new Set(events.flatMap((event) => (event.pid ? [event.pid] : []))),
  ];
  onTestFinished(async () => {
    // Only fixture-owned PIDs/groups, never a user service or a port-based target.
    for (const pid of [
      child.pid!,
      ...pids(),
      ...(borrowed?.pid ? [borrowed.pid] : []),
    ]) {
      if (!alive(pid)) continue;
      try {
        process.kill(-pid, 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
      try {
        if (alive(pid)) process.kill(pid, 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
    await closed;
    await waitFor(
      () =>
        [...pids(), ...(borrowed?.pid ? [borrowed.pid] : [])].every(
          (pid) => !alive(pid),
        ),
      'fixture cleanup stopped all descendants',
    );
    rmSync(directory, { recursive: true });
  });
  return {
    child,
    events,
    waitFor,
    borrowedPid: borrowed?.pid,
    async stopped(code: number) {
      await waitFor(() => exit !== null, 'launcher exited');
      expect(exit).toEqual({ code, signal: null });
      await waitFor(
        () => pids().every((pid) => !alive(pid)),
        'all owned descendants stopped',
      );
      await closed;
    },
    async ready(role: string) {
      await waitFor(
        () =>
          events.some(
            (event) => event.event === 'ready' && event.role === role,
          ),
        `${role} ready`,
      );
    },
    async releaseReadiness() {
      await new Promise<void>((resolve, reject) =>
        child.send('release-readiness', (error) =>
          error ? reject(error) : resolve(),
        ),
      );
    },
    transcripts() {
      return readdirSync(join(directory, 'reports/model-runs'))
        .filter((name) => name.endsWith('.log'))
        .map((name) =>
          readFileSync(join(directory, 'reports/model-runs', name), 'utf8'),
        );
    },
    get output() {
      return output;
    },
  };
}
