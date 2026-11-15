/**
 * The dashboard's Content Security Policy (SECURITY.md §9). `src/proxy.ts` builds it for every page
 * request with a fresh nonce; Next.js puts the same nonce on its own scripts, so a script without it
 * (for example one injected into a page) does not run. 'strict-dynamic' lets those trusted scripts load
 * the rest of the app.
 *
 * Styles still allow 'unsafe-inline': React writes style="…" attributes, which a nonce cannot cover,
 * and inline styles cannot run code. Images: AttendSure itself, data: (the two-step QR code), blob:
 * and the file store (photos). Development also needs 'unsafe-eval' for React's error overlay.
 */
export function contentSecurityPolicy(nonce: string, options: { dev: boolean; filesOrigin: string }): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${options.dev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: ${options.filesOrigin}`,
    "font-src 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
}

/** The file store's public origin (S3_PUBLIC_ENDPOINT), from FILES_ORIGIN; local development by default. */
export function filesOrigin(): string {
  return new URL(process.env.FILES_ORIGIN ?? 'http://localhost:8333').origin;
}

/** A fresh, unpredictable nonce for one response. */
export function newNonce(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}
