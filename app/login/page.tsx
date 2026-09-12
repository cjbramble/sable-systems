'use client';

import Link from 'next/link';
import { SyntheticEvent, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, LockKeyhole, ShieldCheck } from 'lucide-react';

import { BrandWordmark } from '@/components/brand-wordmark';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { safeLoginDestination } from '@/lib/auth-navigation';

const requestedDestination = () => safeLoginDestination(window.location.search);

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [checking, setChecking] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const pageRequest = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    pageRequest.current = controller;
    const destination = requestedDestination();
    fetch('/api/auth/session', { cache: 'no-store', signal: controller.signal })
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
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const payload = (await response.json()) as { error?: string };
      if (signal.aborted) return;
      if (!response.ok)
        throw new Error(payload.error || 'Access could not be verified.');
      window.location.replace(destination);
    } catch (requestError) {
      if (signal.aborted) return;
      setError(
        requestError instanceof Error
          ? requestError.message
          : 'Access could not be verified.',
      );
      setSubmitting(false);
    }
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

          <label htmlFor="access-email">
            <span>Authorized email</span>
            <Input
              id="access-email"
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
              type="password"
              autoComplete="current-password"
              required
              minLength={12}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>

          {error ? <p className="login-error">{error}</p> : null}

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
