import type { AccountSummary } from './contracts';
import type { SupportIncident } from './support-incidents';
import { parseSupportAccount, parseSupportIncidents } from './support-snapshot';

export class SupportSessionExpiredError extends Error {
  constructor() {
    super('Your session has expired. Please sign in again.');
    this.name = 'SupportSessionExpiredError';
  }
}

export async function loadSupportSnapshot(
  signal: AbortSignal,
): Promise<{ account: AccountSummary; incidents: SupportIncident[] }> {
  signal.throwIfAborted();
  const controller = new AbortController();
  let interrupt!: (reason: unknown) => void;
  const interrupted = new Promise<never>((_resolve, reject) => {
    interrupt = reject;
  });
  function onAbort() {
    interrupt(signal.reason);
    controller.abort();
  }
  signal.addEventListener('abort', onAbort, { once: true });
  const deadline = setTimeout(() => {
    interrupt(
      new Error(
        'Support account and history took too long to load. Please try again.',
      ),
    );
    controller.abort();
  }, 10_000);

  async function read<T>(
    endpoint: string,
    parse: (payload: unknown) => T | null,
    errorMessage: string,
  ): Promise<T> {
    try {
      const response = await fetch(endpoint, {
        cache: 'no-store',
        signal: controller.signal,
      });
      controller.signal.throwIfAborted();
      if (response.status === 401) throw new SupportSessionExpiredError();
      if (!response.ok) throw new Error(errorMessage);
      const payload: unknown = await response.json();
      controller.signal.throwIfAborted();
      const value = parse(payload);
      if (value === null) throw new Error(errorMessage);
      return value;
    } catch (error) {
      if (error instanceof SupportSessionExpiredError) throw error;
      throw new Error(errorMessage);
    }
  }

  try {
    // Each read checks its own status and payload immediately. The shared
    // deadline also bounds body reads and transports that ignore cancellation.
    const [account, incidents] = await Promise.race([
      Promise.all([
        read(
          '/api/account',
          parseSupportAccount,
          'Support account details could not be loaded. Please try again.',
        ),
        read(
          '/api/incidents',
          parseSupportIncidents,
          'Support history could not be loaded. Please try again.',
        ),
      ]),
      interrupted,
    ]);
    signal.throwIfAborted();
    return { account, incidents };
  } catch (error) {
    controller.abort();
    throw error;
  } finally {
    clearTimeout(deadline);
    signal.removeEventListener('abort', onAbort);
  }
}
