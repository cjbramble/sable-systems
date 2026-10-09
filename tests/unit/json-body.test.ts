import { describe, expect, it } from 'vitest';
import { BodyTooLargeError, readJsonBody } from '@/lib/json-body';

describe('bounded JSON body reading', () => {
  it('counts bytes and decodes Unicode split between chunks at the exact limit', async () => {
    const bytes = new TextEncoder().encode('{"message":"🙂"}');
    const body = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
            controller.close();
          },
        }),
      );
    await expect(readJsonBody(body(), bytes.length)).resolves.toEqual({
      message: '🙂',
    });
    await expect(readJsonBody(body(), bytes.length - 1)).rejects.toBeInstanceOf(
      BodyTooLargeError,
    );
  });
  it('cancels an oversized stream even with a dishonest Content-Length', async () => {
    let cancelled = false;
    const body = new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(32));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(
      readJsonBody(
        new Response(body, { headers: { 'Content-Length': '1' } }),
        16,
      ),
    ).rejects.toBeInstanceOf(BodyTooLargeError);
    expect(cancelled).toBe(true);
    expect(body.locked).toBe(false);
  });
  it.each(['', '{', '{"message":'])(
    'rejects malformed JSON: %s',
    async (value) => {
      await expect(
        readJsonBody(new Response(value), 100),
      ).rejects.toBeInstanceOf(SyntaxError);
    },
  );
  it('rejects malformed UTF-8 rather than replacing bytes', async () => {
    await expect(
      readJsonBody(new Response(Uint8Array.of(34, 255, 34)), 100),
    ).rejects.toThrow();
  });
  it('preserves interrupted body reads', async () => {
    const error = new DOMException('Timed out', 'TimeoutError');
    const body = new ReadableStream({
      start(controller) {
        controller.error(error);
      },
    });
    await expect(readJsonBody(new Response(body), 100)).rejects.toBe(error);
    expect(body.locked).toBe(false);
  });
});
