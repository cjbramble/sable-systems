// @ts-check

const NEWLINE = 0x0a;

/**
 * Pass only complete lines to `write`, so streams sharing one file cannot
 * split each other's lines. `flush` writes any unterminated remainder.
 * @param {(chunk: Buffer) => void} write
 */
export function createLineFramer(write) {
  /** @type {Buffer[]} */
  let pending = [];
  return {
    /** @param {Buffer | string} chunk */
    push(chunk) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const end = data.lastIndexOf(NEWLINE);
      if (end === -1) {
        pending.push(data);
        return;
      }
      write(Buffer.concat([...pending, data.subarray(0, end + 1)]));
      pending = end + 1 < data.length ? [data.subarray(end + 1)] : [];
    },
    flush() {
      if (pending.length) write(Buffer.concat(pending));
      pending = [];
    },
  };
}
