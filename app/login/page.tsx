'use client';

import Link from 'next/link';
import { SyntheticEvent, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, LockKeyhole, ShieldCheck } from 'lucide-react';

import { BrandWordmark } from '@/components/brand-wordmark';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { safeLoginDestination } from '@/lib/auth-navigation';
import {
  notifySessionChanged,
  withAuthRequestTimeout,
} from '@/lib/client-session';

const LOGIN_FAILED_MESSAGE = 'Access could not be verified.';

const requestedDestination = () => safeLoginDestination(window.location.search);

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [checking, setChecking] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const errorSummary = useRef<HTMLParagraphElement>(null);
  const pageRequest = useRef<AbortController | null>(null);

  useEffect(() => {
    if (error) errorSummary.current?.focus();
  }, [error]);

  useEffect(() => {
    const controller = new AbortController();
    pageRequest.current = controller;
    const destination = requestedDestination();
    // A stalled check times out so the form becomes usable instead of waiting.
    fetch('/api/auth/session', {
      cache: 'no-store',
      signal: withAuthRequestTimeout(controller.signal),
    })
      .then((response) => {
        if (!controller.signal.aborted && response.ok)
          window.location.replace(destination);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!controller.signal.aborted) setChecking(false);
      });
    return () => {
      controller.abort();
    };
  }, []);

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const signal = pageRequest.current?.signal;
    if (!signal || signal.aborted || checking || submitting) return;
    const destination = requestedDestination();
    setSubmitting(true);
    setError('');
    let message = LOGIN_FAILED_MESSAGE;
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        signal: withAuthRequestTimeout(signal),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (signal.aborted) return;
      if (response.ok) {
        notifySessionChanged();
        window.location.replace(destination);
        return;
      }
      message = await loginErrorMessage(response);
    } catch {
      // A network failure or timeout keeps the generic retry message.
    }
    if (signal.aborted) return;
    setError(message);
    setSubmitting(false);
  }

  return (
    <main className="login-page">
      <section className="login-brand" aria-label="SABLE distributor access">
        <BrandWordmark />
        <div className="login-brand__signal" aria-hidden="true">
          <span />
          <i />
          <i />
          <i />
        </div>
        <div>
          <p className="brand-kicker">
            <span /> VERIFIED DISTRIBUTION CHANNEL
          </p>
          <h1>Enter the procurement network.</h1>
          <p>
            Inventory, scheduled releases, account-ledger ordering, and COV-E
            operations support are restricted to authorized distribution users.
          </p>
        </div>
        <p className="login-brand__footer">MVH // IDENTITY RELAY 6.2</p>
      </section>

      <section className="login-panel">
        <Link className="login-back" href="/">
          <ArrowLeft /> Return to SABLE Systems
        </Link>
        <form className="login-form" onSubmit={submit}>
          <div className="login-form__icon">
            <LockKeyhole />
          </div>
          <p className="eyebrow">Authorized user access</p>
          <h2>Verify identity</h2>
          <p className="login-form__lede">
            Use the credentials issued to your distribution account.
          </p>

          {error ? (
            <p
              className="login-error"
              id="login-error"
              ref={errorSummary}
              tabIndex={-1}
            >
              {error}
            </p>
          ) : null}

          <label htmlFor="access-email">
            <span>Authorized email</span>
            <Input
              id="access-email"
              aria-describedby={error ? 'login-error' : undefined}
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="operator@distribution.example"
            />
          </label>
          <label htmlFor="access-password">
            <span>Access phrase</span>
            <Input
              id="access-password"
              aria-describedby={error ? 'login-error' : undefined}
              type="password"
              autoComplete="current-password"
              required
              minLength={12}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>

          <Button type="submit" size="lg" disabled={checking || submitting}>
            {checking
              ? 'Checking channel…'
              : submitting
                ? 'Verifying…'
                : 'Enter authorized channel'}
            <ArrowRight />
          </Button>

          <div className="login-trust">
            <ShieldCheck />
            <span>
              <strong>Private session</strong>
              <small>
                Credentials are verified inside the SABLE access node.
              </small>
            </span>
          </div>
        </form>
      </section>
    </main>
  );
}

async function loginErrorMessage(response: Response) {
  // Proxy and dev-server failures can return HTML or an empty body.
  const payload: unknown = await response.json().catch(() => null);
  const error =
    payload && typeof payload === 'object'
      ? (payload as { error?: unknown }).error
      : undefined;
  return typeof error === 'string' && error ? error : LOGIN_FAILED_MESSAGE;
}
