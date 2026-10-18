'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { loginHref } from './auth-navigation';
import type { SessionSubject } from './contracts';
import { parseSessionSubject, sameSessionSubject } from './session-subject';

const SESSION_CHANGE_KEY = 'sable:session-changed';
const AUTH_REQUEST_TIMEOUT_MS = 10_000;

// A stalled worker must not leave a sign-in, sign-out, or session check pending.
export function withAuthRequestTimeout(signal: AbortSignal) {
  return AbortSignal.any([
    signal,
    AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS),
  ]);
}

export function notifySessionChanged() {
  try {
    // Notify other tabs without storing account data or session credentials.
    localStorage.setItem(SESSION_CHANGE_KEY, crypto.randomUUID());
  } catch {
    // Storage can be unavailable; focus checks and the checkout guard still apply.
  }
}

export function useSessionGuard(
  subject: SessionSubject | null,
  destination: string | (() => string),
  onInvalidated?: () => void,
) {
  const [sessionChanged, setSessionChanged] = useState(false);
  const invalidateSession = useCallback(() => {
    onInvalidated?.();
    setSessionChanged(true);
  }, [onInvalidated]);
  const reviewedSubject = useRef<SessionSubject | null>(null);
  const userId = subject?.userId;
  const customerId = subject?.customerId;

  useEffect(() => {
    if (!userId || !customerId) return;
    const loaded = { userId, customerId };
    reviewedSubject.current ??= loaded;
    const reviewed = reviewedSubject.current;
    // A refreshed account-dependent response must not silently authorize a new
    // subject while an earlier session check is still pending.
    if (!sameSessionSubject(reviewed, loaded)) {
      invalidateSession();
      return;
    }
    let pending: AbortController | null = null;
    async function checkSession() {
      pending?.abort();
      const controller = new AbortController();
      pending = controller;
      try {
        const response = await fetch('/api/auth/session', {
          cache: 'no-store',
          signal: withAuthRequestTimeout(controller.signal),
        });
        if (controller.signal.aborted) return;
        if (response.status === 401) {
          // The session ended; the account did not change. Clear account state
          // and go to sign-in without flashing the account-changed notice.
          onInvalidated?.();
          redirectToLogin(
            typeof destination === 'function' ? destination() : destination,
          );
          return;
        }
        if (!response.ok) return;
        const payload = (await response.json()) as {
          user?: { userId?: unknown; distributorId?: unknown };
        };
        if (controller.signal.aborted) return;
        const current = parseSessionSubject({
          userId: payload.user?.userId,
          customerId: payload.user?.distributorId,
        });
        if (current && !sameSessionSubject(reviewed, current)) {
          invalidateSession();
        }
      } catch {
        // An unavailable check is not proof of a changed identity. Retry on resume;
        // the mutation independently verifies its reviewed subject on the server.
      }
    }
    const onResume = () => {
      if (document.visibilityState === 'visible') void checkSession();
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === SESSION_CHANGE_KEY) void checkSession();
    };
    void checkSession();
    window.addEventListener('focus', onResume);
    window.addEventListener('pageshow', onResume);
    document.addEventListener('visibilitychange', onResume);
    window.addEventListener('storage', onStorage);
    return () => {
      pending?.abort();
      window.removeEventListener('focus', onResume);
      window.removeEventListener('pageshow', onResume);
      document.removeEventListener('visibilitychange', onResume);
      window.removeEventListener('storage', onStorage);
    };
  }, [userId, customerId, destination, invalidateSession, onInvalidated]);

  return { sessionChanged, invalidateSession };
}

export function redirectToLogin(destination: string) {
  window.location.replace(loginHref(destination));
}

export function useSignOut() {
  const pending = useRef<AbortController | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState('');

  useEffect(() => () => pending.current?.abort(), []);

  async function signOut() {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setSigningOut(true);
    setSignOutError('');
    try {
      const response = await fetch('/api/auth/logout', {
        method: 'POST',
        signal: withAuthRequestTimeout(controller.signal),
      });
      if (!response.ok) throw new Error('Sign-out failed');
      if (!controller.signal.aborted) {
        notifySessionChanged();
        window.location.replace('/login');
      }
    } catch {
      if (!controller.signal.aborted)
        setSignOutError('Sign-out could not be confirmed. Please try again.');
    } finally {
      if (!controller.signal.aborted) {
        pending.current = null;
        setSigningOut(false);
      }
    }
  }

  return { signOut, signingOut, signOutError };
}
