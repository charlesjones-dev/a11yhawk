/**
 * Custom scan headers, scoped to the scan target's origin.
 *
 * Hosts pass headers, bearer tokens, and cookies so a scan can reach pages
 * behind auth. Set as context-wide `extraHTTPHeaders`, they would go out with
 * every request the scanned page makes, including third-party scripts, CDNs,
 * and analytics. This module sends them only to the scan target:
 *
 * - Header and authorization entries are added by a context route, and only to
 *   requests whose origin (scheme, host, and port) equals the scan target's.
 *   Subdomains, the bare/www variant, and http vs https are different origins
 *   and get nothing. "Same site" was ruled out on purpose: it would include
 *   hosts the caller never named (user-content subdomains, CNAMEs to third-party
 *   platforms) and would need the Public Suffix List as a dependency.
 * - Cookie entries become browser cookies set for the target URL. A `Cookie`
 *   header entry is converted the same way, because Playwright drops `cookie`
 *   from route header overrides.
 *
 * Install AFTER the SSRF request guard. Playwright runs the most recently
 * registered matching route first, so this handler only adds headers and falls
 * back; the guard still validates every request and continues or aborts it
 * exactly as before.
 *
 * Residual gaps (Playwright behavior, not fixable from a route handler):
 * - Playwright re-applies a request's route header overrides to each redirect
 *   hop of that request, and route handlers are not called for redirect hops.
 *   A same-origin URL that redirects to another origin therefore still delivers
 *   the headers to the redirect target.
 * - WebSocket handshakes are not routed, so they never receive the headers.
 */
import type { BrowserContext } from 'playwright';

import type { ScanHeader } from '../types.js';

/** True when `url` has exactly the given origin (scheme, host, and port). */
export function isTargetOrigin(url: string, targetOrigin: string): boolean {
  try {
    return new URL(url).origin === targetOrigin;
  } catch {
    return false;
  }
}

/** Parse a `Cookie` header value (`a=1; b=2`) into name/value pairs. */
function parseCookieHeader(value: string): Array<{ name: string; value: string }> {
  const cookies: Array<{ name: string; value: string }> = [];
  for (const part of value.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    const name = part.slice(0, separator).trim();
    if (name !== '') cookies.push({ name, value: part.slice(separator + 1).trim() });
  }
  return cookies;
}

/**
 * Split scan header entries into request headers (lowercased names, so they
 * replace rather than duplicate the browser's own) and cookies.
 */
export function partitionScanHeaders(customHeaders: ScanHeader[]): {
  headers: Record<string, string>;
  cookies: Array<{ name: string; value: string }>;
} {
  const headers: Record<string, string> = {};
  const cookies: Array<{ name: string; value: string }> = [];
  for (const header of customHeaders) {
    if (header.type === 'cookie') {
      cookies.push({ name: header.key, value: header.value });
    } else if (header.type === 'authorization') {
      headers['authorization'] = `Bearer ${header.value}`;
    } else if (header.key.toLowerCase() === 'cookie') {
      cookies.push(...parseCookieHeader(header.value));
    } else {
      headers[header.key.toLowerCase()] = header.value;
    }
  }
  return { headers, cookies };
}

/**
 * Apply custom scan headers to a browser context, scoped to the origin of
 * `targetUrl`. Must be called after installRequestGuard and before the first
 * navigation; see the module comment.
 */
export async function installScopedHeaders(
  context: BrowserContext,
  targetUrl: string,
  customHeaders: ScanHeader[] | undefined,
): Promise<void> {
  if (!customHeaders || customHeaders.length === 0) return;
  const { headers, cookies } = partitionScanHeaders(customHeaders);

  if (cookies.length > 0) {
    await context.addCookies(cookies.map((cookie) => ({ ...cookie, url: targetUrl })));
  }

  if (Object.keys(headers).length === 0) return;
  const targetOrigin = new URL(targetUrl).origin;
  await context.route('**/*', async (route) => {
    const request = route.request();
    if (!isTargetOrigin(request.url(), targetOrigin)) {
      await route.fallback();
      return;
    }
    await route.fallback({ headers: { ...request.headers(), ...headers } });
  });
}
