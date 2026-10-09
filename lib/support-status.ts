export type SupportRuntimeState = 'checking' | 'ready' | 'offline';

export function startSupportStatusPolling(
  onStatus: (status: SupportRuntimeState) => void,
): () => void {
  let active = true;
  let visible = document.visibilityState === 'visible';
  let pending: AbortController | null = null;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let nextPoll: ReturnType<typeof setTimeout> | undefined;

  function cancel() {
    clearTimeout(nextPoll);
    nextPoll = undefined;
    clearTimeout(deadline);
    deadline = undefined;
    const controller = pending;
    pending = null;
    controller?.abort();
  }

  async function poll() {
    if (!active || !visible || pending) return;
    nextPoll = undefined;
    const controller = new AbortController();
    pending = controller;

    function settle(status: 'ready' | 'offline') {
      // A cancelled request may finish after a new visible check has started.
      if (!active || pending !== controller) return;
      clearTimeout(deadline);
      deadline = undefined;
      pending = null;
      onStatus(status);
      if (active && visible) nextPoll = setTimeout(() => void poll(), 10_000);
    }

    deadline = setTimeout(() => {
      // Release the polling lifecycle even if a transport ignores abort.
      settle('offline');
      controller.abort();
    }, 5_000);

    try {
      const response = await fetch('/api/status', {
        cache: 'no-store',
        signal: controller.signal,
      });
      if (pending !== controller) return;
      if (!response.ok) {
        settle('offline');
        controller.abort();
        return;
      }
      const payload: unknown = await response.json();
      settle(
        payload !== null &&
          typeof payload === 'object' &&
          !Array.isArray(payload) &&
          'ready' in payload &&
          payload.ready === true
          ? 'ready'
          : 'offline',
      );
    } catch {
      settle('offline');
    }
  }

  function onVisibilityChange() {
    const nextVisible = document.visibilityState === 'visible';
    if (nextVisible === visible) return;
    visible = nextVisible;
    if (visible) void poll();
    else cancel();
  }

  document.addEventListener('visibilitychange', onVisibilityChange);
  if (visible) void poll();

  return () => {
    active = false;
    document.removeEventListener('visibilitychange', onVisibilityChange);
    cancel();
  };
}
