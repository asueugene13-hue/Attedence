import path from 'node:path';
import type { NextConfig } from 'next';

/** Where the dashboard's server forwards /api/v1 requests. In production the load balancer routes /api instead. */
const apiUrl = process.env.API_INTERNAL_URL ?? 'http://localhost:3000';

const securityHeaders = [
  // Scripts are not yet restricted by CSP (Next.js injects inline scripts; a nonce-based policy is a later step).
  {
    key: 'Content-Security-Policy',
    value: "frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'",
  },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
];

/**
 * The container image (apps/web/Dockerfile) sets NEXT_OUTPUT_STANDALONE=true: Next.js then copies only the
 * files the server needs into .next/standalone. Tracing starts at the repository root so the shared
 * packages are included; the build runs from apps/web. Local development and the browser tests are unchanged.
 */
const standalone = process.env.NEXT_OUTPUT_STANDALONE === 'true';

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  ...(standalone
    ? { output: 'standalone', outputFileTracingRoot: path.resolve(process.cwd(), '../..') }
    : {}),
  // Same origin for the browser: the refresh cookie stays first-party and no CORS opening is needed on the API.
  async rewrites() {
    return [{ source: '/api/v1/:path*', destination: `${apiUrl}/api/v1/:path*` }];
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default config;
