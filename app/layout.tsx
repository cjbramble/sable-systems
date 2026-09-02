import type { Metadata } from 'next';

import './globals.css';

export const metadata: Metadata = {
  title: 'SABLE Customer Operations — Morrow Vale Holdings',
  description:
    'Private wholesale customer operations for Calder Pike Distribution.',
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
