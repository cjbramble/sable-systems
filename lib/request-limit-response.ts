export function requestLimitResponse(retryAfter: number, code?: string) {
  return Response.json(
    {
      error: 'Too many requests. Please wait and try again.',
      ...(code === undefined ? {} : { code }),
    },
    {
      status: 429,
      headers: {
        'Retry-After': String(retryAfter),
        'Cache-Control': 'no-store',
      },
    },
  );
}
