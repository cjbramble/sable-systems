import { describe, expect, test } from 'vitest';
import { alive, launchFixture } from '../fixtures/runtime/launcher';

describe.skipIf(process.platform === 'win32')(
  'local launcher process ownership',
  { timeout: 12000 },
  () => {
    test('stops the actual npm wrapper and web descendant on normal development shutdown', async () => {
      const app = launchFixture('dev-normal');
      await app.ready('web');
      app.child.kill('SIGTERM');
      await app.stopped(0);
    });

    test.for(['dev-late-readiness', 'test-late-readiness'])(
      'does not launch after shutdown begins: %s',
      async (scenario) => {
        const app = launchFixture(scenario);
        await app.waitFor(
          () => app.events.some((event) => event.event === 'readiness-poll'),
          'readiness in flight',
        );
        app.child.kill('SIGTERM');
        await app.waitFor(
          () => app.events.some((event) => event.event === 'term'),
          'shutdown reached model',
        );
        await app.releaseReadiness();
        await app.stopped(scenario.startsWith('dev-') ? 0 : 143);
        expect(
          app.events
            .filter((event) => event.event === 'spawn-request')
            .map((event) => event.role),
        ).toEqual(['model']);
      },
    );

    test.for([
      'dev-interrupt-loading',
      'test-interrupt-loading',
      'test-interrupt-probe',
      'test-timeout',
      'dev-spawn-failure',
      'test-spawn-failure',
      'dev-web-spawn-failure',
    ])('cleans up failed or interrupted startup: %s', async (scenario) => {
      const app = launchFixture(scenario);
      if (scenario.includes('interrupt-')) {
        await app.waitFor(
          () => app.events.some((event) => event.event === 'readiness-poll'),
          'readiness pending',
        );
        app.child.kill('SIGTERM');
      }
      await app.stopped(
        scenario === 'dev-interrupt-loading'
          ? 0
          : scenario.startsWith('test-interrupt-')
            ? 143
            : 1,
      );
      if (scenario === 'test-interrupt-probe')
        expect(
          app.events.some((event) => event.event === 'spawn-request'),
        ).toBe(false);
    });

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
      'forces termination after grace period: %s',
      async (scenario) => {
        const app = launchFixture(scenario);
        if (scenario.startsWith('dev-')) {
          await app.ready('web');
          app.child.kill('SIGTERM');
        }
        await app.stopped(0);
        expect(app.events).toContainEqual(
          expect.objectContaining({
            event: 'child-exit',
            role: 'model',
            signal: 'SIGKILL',
          }),
        );
      },
    );

    test('borrows an existing model and retains the final test verdict', async () => {
      const app = launchFixture('test-borrowed');
      await app.stopped(0);
      expect(app.events.some((event) => event.role === 'model')).toBe(false);
      expect(alive(app.borrowedPid!)).toBe(true);
      expect(app.transcripts()).toEqual([
        expect.stringContaining('final test verdict'),
      ]);
    });

    test('cleans up descendants left by normally exiting tests', async () => {
      const app = launchFixture('test-descendant');
      await app.stopped(0);
      expect(app.events).toContainEqual(
        expect.objectContaining({ role: 'test-descendant', event: 'ready' }),
      );
    });

    test('stops tests when the owned model dies unexpectedly', async () => {
      const app = launchFixture('test-model-dies');
      await app.ready('vitest');
      process.kill(
        app.events.find(
          (event) => event.event === 'ready' && event.role === 'model',
        )!.pid!,
        'SIGKILL',
      );
      await app.stopped(1);
      expect(app.transcripts()).toEqual([
        expect.stringContaining('partial transcript: final shutdown chunk'),
      ]);
    });
  },
);
