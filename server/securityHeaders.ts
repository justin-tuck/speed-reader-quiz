/**
 * Content security policy for the site's pages. Used by the CloudFront
 * distribution (infra/) and by the local preview server, so the same policy
 * can be tested before deploying.
 *
 * @param connectOrigins extra origins the page may call, e.g. the Cognito endpoints.
 */
export function siteContentSecurityPolicy(connectOrigins: string[]): string {
  return [
    "default-src 'self'",
    // pdf.js may compile WebAssembly for some PDF features.
    "script-src 'self' 'wasm-unsafe-eval'",
    "worker-src 'self' blob:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src ${["'self'", ...connectOrigins].join(' ')}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}
