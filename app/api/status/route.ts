import { isSupportModelReady } from '@/lib/model-readiness.mjs';
import { supportModelConfig } from '@/lib/support-model-runtime';
import { logServerError } from '@/lib/server-log';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const ready = await isSupportModelReady(
      AbortSignal.timeout(2_500),
      supportModelConfig(),
    );
    return Response.json({ ready }, { status: ready ? 200 : 503 });
  } catch (error) {
    // A slow provider is an expected offline result, and the support page
    // polls this route, so only unexpected failures are logged.
    if (!isDeadlineError(error)) logServerError('model status', error);
    return Response.json({ ready: false }, { status: 503 });
  }
}

function isDeadlineError(error: unknown) {
  return (
    error instanceof DOMException &&
    (error.name === 'TimeoutError' || error.name === 'AbortError')
  );
}
