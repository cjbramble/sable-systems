'use client';

import { loginHref } from './auth-navigation';

export function redirectToLogin(destination: string) {
  window.location.replace(loginHref(destination));
}

export async function signOut() {
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } finally {
    window.location.replace('/login');
  }
}
