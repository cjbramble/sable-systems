import { describe, expect, it } from 'vitest';
import { createLineFramer } from '../../scripts/lib/line-framer.mjs';
import {
  parseModelTestArgs,
  shellQuote,
} from '../../scripts/lib/model-test-args.mjs';
import { createProcessScope } from '../../scripts/lib/process-scope.mjs';

describe('line framer', () => {
  it('keeps a line split across chunks intact when another stream writes between', () => {
    const file: string[] = [];
    const write = (data: Buffer) => file.push(data.toString());
    const stdout = createLineFramer(write);
    const stderr = createLineFramer(write);
    stdout.push(Buffer.from('Case-pack sample: {"sample":'));
    stderr.push(Buffer.from('worker warning\n'));
    stdout.push(Buffer.from('1}\nnext '));
    stdout.push('line');
    stdout.flush();
    stdout.flush();
    expect(file.join('')).toBe(
      'worker warning\nCase-pack sample: {"sample":1}\nnext line',
    );
  });

  it('keeps multibyte characters split across chunks', () => {
    const file: Buffer[] = [];
    const lines = createLineFramer((data) => file.push(data));
    const text = Buffer.from('COV-E — ready\n');
    lines.push(text.subarray(0, 7));
    lines.push(text.subarray(7));
    expect(Buffer.concat(file).toString()).toBe('COV-E — ready\n');
  });
});

describe('model test arguments', () => {
  it('runs the judge by default and passes other arguments to Vitest', () => {
    expect(parseModelTestArgs(['tests/model/a.test.ts', '-t', 'x'])).toEqual({
      vitestArgs: ['tests/model/a.test.ts', '-t', 'x'],
      judge: true,
    });
  });

  it('skips the billed judge with --no-judge without passing it to Vitest', () => {
    expect(
      parseModelTestArgs(['--no-judge', '--reporter=verbose', 'file']),
    ).toEqual({ vitestArgs: ['file'], judge: false });
  });

  it.each([['--reporter', 'dot'], ['--reporter=json'], ['--silent']])(
    'rejects arguments that would hide sample evidence: %s',
    (...args) => {
      expect(() => parseModelTestArgs(args)).toThrow(/verbose|Silent/);
    },
  );
});

describe('shell quoting', () => {
  it('leaves plain paths readable', () => {
    expect(shellQuote('/repo/reports/model-runs/a-1.log')).toBe(
      '/repo/reports/model-runs/a-1.log',
    );
  });

  it('single-quotes paths with spaces, quotes, and shell syntax', () => {
    expect(shellQuote("/My Repos/it's $HOME/`date`;*.log")).toBe(
      String.raw`'/My Repos/it'\''s $HOME/` + "`date`;*.log'",
    );
  });
});

it('refuses to start launchers on Windows', () => {
  expect(() => createProcessScope({ platform: 'win32' })).toThrow('WSL');
});
