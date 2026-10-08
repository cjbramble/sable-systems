import { Response, type Request } from 'miniflare';

// The offline Worker runtime terminates every fetch here, including redirects.
// Tests select a response with dummy credentials; no provider is contacted.
export function createModelTransportFixture() {
  const visits = new Map<string, string[]>();
  return async (request: Request) => {
    const url = new URL(request.url);
    if (url.origin === 'https://model-transport.test') {
      const id = url.pathname.slice(1);
      const observed = visits.get(id) ?? [];
      if (request.method === 'DELETE') visits.delete(id);
      return Response.json(observed);
    }

    const match = request.headers
      .get('Authorization')
      ?.match(
        /^Bearer transport-test:([^:]+):(200|301|302|303|307|308):(same|cross)$/,
      );
    const redirectedId = url.pathname.startsWith('/redirect/')
      ? url.pathname.slice('/redirect/'.length)
      : null;
    const id = redirectedId ?? match?.[1];
    if (!id)
      return new Response('Unexpected offline model request', { status: 502 });
    const observed = visits.get(id) ?? [];
    observed.push(request.url);
    visits.set(id, observed);

    if (!redirectedId && match && match[2] !== '200') {
      const origin =
        match[3] === 'same' ? url.origin : 'https://redirect.model.test';
      return new Response(null, {
        status: Number(match[2]),
        headers: { Location: `${origin}/redirect/${id}` },
      });
    }
    return Response.json({
      data: { limit_remaining: 1 },
      choices: [
        {
          finish_reason: 'stop',
          message: { content: 'Please provide the shipment reference.' },
        },
      ],
    });
  };
}
