import { type NextRequest, NextResponse } from 'next/server';
import { contentSecurityPolicy, filesOrigin, newNonce } from '@/lib/csp';

/**
 * Runs before every page is rendered: a fresh nonce and the Content Security Policy built with it.
 * Next.js reads the policy from the request, finds the nonce and puts it on its scripts (pages are
 * rendered per request for this: see app/layout.tsx). Static files and the /api proxy are left alone.
 */
export function proxy(request: NextRequest) {
  const nonce = newNonce();
  const policy = contentSecurityPolicy(nonce, {
    dev: process.env.NODE_ENV === 'development',
    filesOrigin: filesOrigin(),
  });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', policy);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', policy);
  return response;
}

export const config = {
  matcher: [
    {
      source: '/((?!api|_next/static|_next/image|brand|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
