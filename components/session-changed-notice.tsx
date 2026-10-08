'use client';

import { ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function SessionChangedNotice({
  children,
}: {
  children?: React.ReactNode;
}) {
  return (
    <main className="access-check">
      <ShieldCheck aria-hidden="true" />
      <div role="alert">
        <h1>Your account changed</h1>
        <p>Reload to review the current account before continuing.</p>
        {children}
        <Button onClick={() => window.location.reload()}>Reload account</Button>
      </div>
    </main>
  );
}
