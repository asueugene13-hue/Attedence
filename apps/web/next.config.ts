import path from 'node:path';
import type { NextConfig } from 'next';

/** Where the dashboard's server forwards /api/v1 requests. In production the load balancer routes /api instead. */
const apiUrl = process.env.API_INTERNAL_URL ?? 'http://localhost:3000';

/**
 * Where the browser may load student photos from: the file store's public address (S3_PUBLIC_ENDPOINT).
 * Fixed when the dashboard is built (the image takes it as the FILES_ORIGIN build argument).
 */
const filesOrigin = new URL(process.env.FILES_ORIGIN ?? 'http://localhost:8333').origin;
const isDev = process.env.NODE_ENV !== 'production';

/**
 * Everything comes from AttendSure itself, except photos (the file store) and the QR code (a data: image).
 * Inline scripts and styles are still allowed because Next.js adds them; a nonce-based policy that removes
 * 'unsafe-inline' is a later step (KNOWN_LIMITATIONS). Development also needs 'unsafe-eval' for hot reload.
 */
const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob: ${filesOrigin}`,
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

const securityHeaders = [
  { key: 'Content-Security-Policy', value: contentSecurityPolicy },
  // Keeps other sites' windows and pages from reaching into the dashboard (site isolation).
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
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
