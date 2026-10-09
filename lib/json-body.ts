export class BodyTooLargeError extends Error {
  constructor() {
    super('JSON body exceeds its byte limit.');
    this.name = 'BodyTooLargeError';
  }
}

// Count actual bytes, including on chunked responses or untrusted length headers.
// Reading the stream preserves the fetch deadline's timeout/abort errors.
export async function readJsonBody(
  source: Pick<Response, 'body'>,
  maxBytes: number,
): Promise<unknown> {
  if (!source.body) throw new SyntaxError('Missing JSON body.');
  const reader = source.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new BodyTooLargeError();
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode()) as unknown;
  } catch (error) {
    // A failed cancellation must not replace the original parse/transport error.
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}
