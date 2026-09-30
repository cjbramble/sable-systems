import { isSupportModelReady } from '@/lib/model-readiness.mjs';
import { supportModelConfig } from '@/lib/support-model-runtime';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const ready = await isSupportModelReady(
      AbortSignal.timeout(2_500),
      supportModelConfig(),
    );
    return Response.json({ ready }, { status: ready ? 200 : 503 });
  } catch {
    return Response.json({ ready: false }, { status: 503 });
  }
}
