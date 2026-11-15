import '@attendsure/design-tokens/tokens.css';
import './globals.css';
import type { Metadata } from 'next';
import { connection } from 'next/server';
import type { ReactNode } from 'react';
import { Providers } from './providers';

export const metadata: Metadata = {
  title: { default: 'AttendSure', template: '%s · AttendSure' },
  description: 'Attendance and class monitoring for Knutsford University',
  robots: { index: false, follow: false },
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Rendered for each request, so every page carries the fresh script nonce from src/proxy.ts.
  await connection();
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
