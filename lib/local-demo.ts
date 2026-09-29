import { env } from 'cloudflare:workers';

// Publicly documented seed credentials belong only to the local demo. Builds
// have this binding disabled; local launchers and disposable tests opt in.
export function isLocalDemoRequest(request: Request) {
  const enabled = (env as { SABLE_LOCAL_DEMO?: string }).SABLE_LOCAL_DEMO;
  return (
    enabled === 'true' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(new URL(request.url).hostname)
  );
}
