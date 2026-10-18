// @ts-check

/**
 * Split launcher options from Vitest arguments.
 * @param {string[]} suppliedArgs
 * @returns {{vitestArgs: string[], judge: boolean}}
 */
export function parseModelTestArgs(suppliedArgs) {
  // Console records are the worker-to-host evidence channel. Do not let a
  // silent/custom reporter turn an executed sampling test into a skipped score.
  const vitestArgs = [];
  let judge = true;
  for (let index = 0; index < suppliedArgs.length; index++) {
    const arg = suppliedArgs[index];
    if (arg === '--no-judge') judge = false;
    else if (arg === '--reporter' || arg.startsWith('--reporter=')) {
      const reporter =
        arg === '--reporter'
          ? suppliedArgs[++index]
          : arg.slice('--reporter='.length);
      if (reporter !== 'verbose')
        throw new Error('Model transcript capture requires --reporter=verbose');
    } else if (arg === '--silent' || arg.startsWith('--silent=')) {
      throw new Error(
        'Silent model tests cannot retain model evaluation evidence',
      );
    } else vitestArgs.push(arg);
  }
  return { vitestArgs, judge };
}

/**
 * Quote a value for a copyable POSIX shell command.
 * @param {string} value
 */
export function shellQuote(value) {
  return /^[\w@%+=:,./-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", `'\\''`)}'`;
}
