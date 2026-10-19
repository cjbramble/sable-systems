import { getAuthenticatedUser } from '@/db/auth';
import { getDatabase } from '@/db/database';
import {
  isSupportModelReady,
  MODEL_READINESS_CACHE_MS,
} from '@/lib/model-readiness.mjs';
import { supportModelConfig } from '@/lib/support-model-runtime';
import { logServerError } from '@/lib/server-log';

export const dynamic = 'force-dynamic';

// Only settled results are shared: Workers must not await another request's I/O.
let cached: { ready: boolean; checkedAt: number } | undefined;

export async function GET(request: Request) {
  try {
    const db = await getDatabase();
    if (!(await getAuthenticatedUser(db, request)))
      return Response.json(
        { error: 'Authentication required.' },
        { status: 401 },
      );
  } catch (error) {
    logServerError('model status', error);
    return Response.json({ ready: false }, { status: 503 });
  }
  const ready = await checkReadiness();
  return Response.json({ ready }, { status: ready ? 200 : 503 });
}

async function checkReadiness() {
  const now = Date.now();
  if (
    cached &&
    now >= cached.checkedAt &&
    now - cached.checkedAt < MODEL_READINESS_CACHE_MS
  )
    return cached.ready;
  let ready = false;
  try {
    ready = await isSupportModelReady(
      AbortSignal.timeout(2_500),
      supportModelConfig(),
    );
  } catch (error) {
    // A slow provider is an expected offline result, and the support page
    // polls this route, so only unexpected failures are logged.
    if (!isDeadlineError(error)) logServerError('model status', error);
  }
  cached = { ready, checkedAt: Date.now() };
  return ready;
}

function isDeadlineError(error: unknown) {
  return (
    error instanceof DOMException &&
    (error.name === 'TimeoutError' || error.name === 'AbortError')
  );
}
