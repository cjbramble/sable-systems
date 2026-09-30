// Exercise real process cleanup while replacing only billed test execution.
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';

const childPath = fileURLToPath(new URL('./child.mjs', import.meta.url));
const scenario = process.env.LAUNCHER_TEST_CASE;
const send = (message) => process.send?.(message);
const originalSpawn = childProcess.spawn;
process.channel?.unref();

childProcess.spawn = (command, args, options) => {
  const role = command === 'npm' ? 'web-wrapper' : 'vitest';
  send({ event: 'spawn-request', role, command, args });
  const failSpawn = scenario.endsWith('spawn-failure');
  const child =
    role === 'web-wrapper' || failSpawn
      ? originalSpawn(
          failSpawn ? '/nonexistent/launcher-test-command' : command,
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
  child.on('message', send);
  child.on('exit', (code, signal) =>
    send({ event: 'child-exit', role, pid: child.pid, code, signal }),
  );
  return child;
};
syncBuiltinESMExports();
