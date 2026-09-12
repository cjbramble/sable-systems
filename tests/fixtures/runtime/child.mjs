import { writeSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const role = process.argv[2];
const scenario = process.env.LAUNCHER_TEST_CASE;
function report(event) {
  const message = { event, role, pid: process.pid, ppid: process.ppid };
  if (process.send && process.connected) process.send(message);
  else writeSync(1, `LAUNCHER_EVENT ${JSON.stringify(message)}\n`);
}

process.on('SIGTERM', () => {
  report('term');
  if (scenario.endsWith('resistant') && role === 'model') return;
  if (role === 'vitest') {
    // A delayed final chunk proves the parent drains streams before finishing.
    setTimeout(() => {
      process.stdout.write('partial transcript: final shutdown chunk\n', () =>
        process.exit(0),
      );
    }, 40);
  } else process.exit(0);
});
report('ready');
if (role === 'vitest') {
  process.stdout.write('partial transcript: test started\n');
  if (scenario === 'test-descendant') {
    const child = spawn(
      process.execPath,
      [fileURLToPath(import.meta.url), 'test-descendant'],
      {
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      },
    );
    child.on('message', (message) => {
      process.send?.(message);
      if (message.event === 'ready') process.exit(0);
    });
  }
  if (
    scenario.endsWith('normal') ||
    scenario.endsWith('borrowed') ||
    scenario.endsWith('resistant')
  ) {
    setTimeout(
      () => process.stdout.write('final test verdict\n', () => process.exit(0)),
      40,
    );
  }
}
setInterval(() => {}, 1000);
