import { describe, expect, test } from 'vitest';
import { launchFixture } from '../fixtures/runtime/launcher';

describe.skipIf(process.platform === 'win32')(
  'inference launcher process ownership',
  { timeout: 12000 },
  () => {
    test('reports how to install a missing judge interpreter', async () => {
      const app = launchFixture('judge-missing-interpreter');
      await app.stopped(1);
      expect(app.output).toContain('npm run setup:judge');
      expect(app.output).toContain('ENOENT');
    });
    test('preserves permission errors from judge startup', async () => {
      const app = launchFixture('judge-permission-failure');
      await app.stopped(1);
      expect(app.output).toContain('EACCES');
    });
    test('lists judge scenarios without credentials', async () => {
      const app = launchFixture('judge-list');
      await app.stopped(0);
      expect(app.output).toContain('judge scenarios listed');
      expect(app.output).not.toContain('launcher-test-key');
    });
    test('propagates judge evaluation failure', async () => {
      const app = launchFixture('judge-exit-failure');
      await app.stopped(7);
    });
    test.for(['SIGINT', 'SIGTERM'] as const)(
      'stops interrupted judge evaluation: %s',
      async (signal) => {
        const app = launchFixture('judge-interrupt');
        await app.ready('judge');
        app.child.kill(signal);
        await app.stopped(signal === 'SIGINT' ? 130 : 143);
      },
    );

    test.for(['dev-normal', 'test-normal'])(
      'runs using OpenRouter only: %s',
      async (scenario) => {
        const app = launchFixture(scenario);
        if (scenario.startsWith('dev-')) {
          await app.ready('web');
          app.child.kill('SIGTERM');
        }
        await app.stopped(0);
        expect(
          app.events
            .filter((event) => event.event === 'spawn-request')
            .map((event) => event.role),
        ).toEqual([scenario.startsWith('dev-') ? 'web-wrapper' : 'vitest']);
        expect(app.output).not.toContain('launcher-test-key');
      },
    );

    test.for(['dev-missing-key', 'test-missing-key'])(
      'rejects blank credentials before starting any process: %s',
      async (scenario) => {
        const app = launchFixture(scenario);
        await app.stopped(1);
        expect(
          app.events.some((event) => event.event === 'spawn-request'),
        ).toBe(false);
        expect(app.output).toContain('Fill in OPENROUTER_API_KEY');
      },
    );

    test.for(['dev-spawn-failure', 'test-spawn-failure'])(
      'reports failed process startup: %s',
      async (scenario) => {
        const app = launchFixture(scenario);
        await app.stopped(1);
      },
    );

    test('reports an unexpectedly signaled web wrapper as failure and stops descendants', async () => {
      const app = launchFixture('dev-web-signal');
      await app.ready('web');
      process.kill(
        app.events.find(
          (event) => event.event === 'spawned' && event.role === 'web-wrapper',
        )!.pid!,
        'SIGTERM',
      );
      await app.stopped(1);
    });

    test.for(['SIGINT', 'SIGTERM'] as const)(
      'stops interrupted tests and drains their partial transcript: %s',
      async (signal) => {
        const app = launchFixture('test-interrupt-running');
        await app.ready('vitest');
        app.child.kill(signal);
        await app.stopped(signal === 'SIGINT' ? 130 : 143);
        expect(app.transcripts()).toEqual([
          expect.stringContaining('partial transcript: final shutdown chunk'),
        ]);
      },
    );

    test.for(['dev-resistant', 'test-resistant'])(
      'forces termination after the grace period: %s',
      async (scenario) => {
        const app = launchFixture(scenario);
        await app.ready(scenario.startsWith('dev-') ? 'web' : 'vitest');
        app.child.kill('SIGTERM');
        await app.stopped(scenario.startsWith('dev-') ? 0 : 143);
        if (scenario.startsWith('test-'))
          expect(app.events).toContainEqual(
            expect.objectContaining({
              event: 'child-exit',
              role: 'vitest',
              signal: 'SIGKILL',
            }),
          );
      },
    );

    test('keeps stdout records whole when stderr writes between their chunks', async () => {
      const app = launchFixture('test-interleaved');
      await app.stopped(0);
      const [transcript] = app.transcripts();
      expect(transcript.split('\n')).toEqual(
        expect.arrayContaining([
          'Split record: {"sample":1}',
          'worker warning',
        ]),
      );
    });

    test('cleans up descendants left by normally exiting tests', async () => {
      const app = launchFixture('test-descendant');
      await app.stopped(0);
      expect(app.events).toContainEqual(
        expect.objectContaining({ role: 'test-descendant', event: 'ready' }),
      );
    });
  },
);
