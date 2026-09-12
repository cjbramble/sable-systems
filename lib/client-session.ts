'use client';

import { useEffect, useRef, useState } from 'react';
import { loginHref } from './auth-navigation';

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
        signal: controller.signal,
      });
      if (!response.ok) throw new Error('Sign-out failed');
      if (!controller.signal.aborted) window.location.replace('/login');
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
