import type { Metadata } from 'next';

import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL(
    process.env.SITE_URL ?? 'http://127.0.0.1:8016',
  ),
  title: {
    default: 'SABLE Systems — Infrastructure for the Post-Human Century',
    template: '%s — SABLE Systems',
  },
  description:
    'Wholesale compute, neural interface, cybernetic, and security systems from Morrow Vale Holdings.',
  openGraph: {
    type: 'website',
    title: 'SABLE Systems',
    description: 'Infrastructure for the post-human century.',
    images: [{ url: '/og.png', width: 1672, height: 941, alt: 'SABLE Systems dimensional signal-grid mark' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'SABLE Systems',
    description: 'Infrastructure for the post-human century.',
    images: ['/og.png'],
  },
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
