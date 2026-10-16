// Browser mutation-origin policy. Header omission remains supported for local
// server and CLI clients; session authentication is a separate requirement.
export function isTrustedMutation(request: Request) {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) return false;
  const fetchSite = request.headers.get('sec-fetch-site');
  return (
    !fetchSite ||
    fetchSite === 'same-origin' ||
    fetchSite === 'same-site' ||
    fetchSite === 'none'
  );
}
