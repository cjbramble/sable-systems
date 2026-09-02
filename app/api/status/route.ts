const MODEL_SERVER_URL = 'http://127.0.0.1:8017/v1/models';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const response = await fetch(MODEL_SERVER_URL, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(2_500),
    });

    if (!response.ok) {
      return Response.json({ ready: false }, { status: 503 });
    }

    return Response.json({ ready: true });
  } catch {
    return Response.json({ ready: false }, { status: 503 });
  }
}
