import { isSupportModelReady } from '@/lib/model-readiness.mjs';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const ready = await isSupportModelReady(AbortSignal.timeout(2_500));
    return Response.json({ ready }, { status: ready ? 200 : 503 });
  } catch {
    return Response.json({ ready: false }, { status: 503 });
  }
}
