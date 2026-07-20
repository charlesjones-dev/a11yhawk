/**
 * SSRF request guard for worker-side Playwright navigation (security audit H-1).
 *
 * Enqueue-time URL validation is not enough: the page can redirect the browser to an
 * internal host after validation passed (redirect bypass), or a low-TTL DNS record can
 * be re-pointed at a private address between validation and fetch (DNS rebinding).
 *
 * This module guards every network request made by the scan's browser CONTEXT:
 *
 * 1. `context.route('**\/*')` validates every request URL (structure + a fresh DNS check)
 *    before the browser sends it, and aborts requests to private/reserved targets. It is
 *    installed on the context, NOT a single page, because Playwright does not invoke a
 *    page-scoped route handler for a popup / `target=_blank` window's first navigation - a
 *    scanned page could otherwise open a window straight to an internal URL and issue an
 *    unguarded request (Codex PR #77 review).
 * 2. Playwright never invokes route handlers for redirect hops (the handler is only
 *    called for the first URL in a redirect chain), so redirected requests are caught
 *    via `context.on('request')` instead. A redirect hop has already been issued by the
 *    time we see it, so on a violation the offending page is closed immediately - the
 *    response never reaches the screenshot, HTML capture, accessibility tree, or LLM.
 *    Each redirect validation is tracked so `assertNoViolation()` can await it before the
 *    capture result is trusted (otherwise a fast internal redirect could be captured and
 *    returned before a slow DNS verdict closes the page).
 *
 * Residual risk (documented in docs/kb/conventions/url-validation.md): a redirect hop
 * to an internal host still causes one blind GET before the page is killed, WebSocket
 * connections are not intercepted by route handlers, and the Lighthouse subprocess
 * performs its own un-intercepted navigation. Blocking non-public egress at the network
 * layer is the only complete fix for those.
 */
import * as dns from 'dns/promises';
import type { BrowserContext, Page, Request } from 'playwright';
import { validateUrlSync, isPrivateIpAddress } from './url-validator.js';
import type { Logger } from '../logger/index.js';

/** Thrown when a scan is aborted because the page tried to reach a private/internal target. */
export class BlockedRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlockedRequestError';
  }
}

export interface TargetVerdict {
  allowed: boolean;
  reason?: string;
}

/**
 * Options shared by the request guard and its lower-level target check.
 */
export interface RequestGuardOptions {
  /**
   * Permit requests and redirect hops whose target is (or resolves to) a private, loopback,
   * or link-local address. Enables scanning internal/private infrastructure end to end.
   *
   * Every other protection stays in force: scheme validation (only http(s) is ever fetched),
   * per-request DNS resolution, fail-closed handling of unexpected resolver errors, and
   * redirect-hop detection. Defaults to false, which keeps SSRF blocking byte-for-byte
   * identical to a guard that never saw this option.
   */
  allowPrivateNetworks?: boolean;
}

// In-flight lookup de-duplication. We deliberately do NOT cache a resolved verdict across
// time: caching an *allow* decision would re-open the exact DNS-rebinding hole this guard
// exists to close. A page that resolves `attacker.test` to a public IP once, then rebinds
// the same hostname to 127.0.0.1 and triggers another fetch, must NOT get a stale "allowed"
// verdict (Codex PR #77 review). We only coalesce lookups that overlap *at the same instant*:
// they share a single resolution and the entry is dropped the moment it settles, so every
// subsequent request re-resolves. Concurrent overlap is far shorter than the request/respond
// round-trip a rebinding attack needs to flip DNS, so sharing it cannot be exploited.
// Sequential-request performance relies on the OS resolver cache (the same cache Chromium
// reads when it actually connects).
const inflightLookups = new Map<string, Promise<TargetVerdict>>();

// Exposed for tests to reset transient in-flight state between cases.
export function clearDnsVerdictCache(): void {
  inflightLookups.clear();
}

async function lookupHostVerdict(hostname: string, allowPrivateNetworks: boolean): Promise<TargetVerdict> {
  try {
    // dns.lookup (getaddrinfo) matches OS-level resolution including /etc/hosts entries,
    // unlike dns.resolve4/6 which query nameservers directly and would miss a hosts-file
    // mapping that Chromium would honor.
    const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
    const privateAddress = addresses.find((entry) => isPrivateIpAddress(entry.address));
    // A private resolution is fatal only in the default posture. When private-network
    // scanning is enabled the DNS lookup still runs (so rebinding is observed and the
    // resolver-error handling below stays active), but a private answer is the operator's
    // intent and is permitted.
    if (privateAddress && !allowPrivateNetworks) {
      return { allowed: false, reason: `hostname resolves to private address ${privateAddress.address}` };
    }
    return { allowed: true };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOTFOUND' || code === 'ENODATA') {
      // Unresolvable host: allow it through so the browser fails with its own,
      // more descriptive name-resolution error.
      return { allowed: true };
    }
    // Fail closed on unexpected resolver errors.
    return { allowed: false, reason: `DNS resolution failed (${code ?? 'unknown error'})` };
  }
}

function resolveHostVerdict(hostname: string, allowPrivateNetworks: boolean): Promise<TargetVerdict> {
  // Re-resolve on every request; only share a lookup that is genuinely in flight right now.
  // The verdict depends on allowPrivateNetworks, so it is part of the coalescing key: two
  // guards with different postures resolving the same host must not share a verdict.
  const key = `${allowPrivateNetworks ? 'allow-private' : 'block-private'}:${hostname}`;
  const inflight = inflightLookups.get(key);
  if (inflight) {
    return inflight;
  }
  const lookup = lookupHostVerdict(hostname, allowPrivateNetworks).finally(() => {
    inflightLookups.delete(key);
  });
  inflightLookups.set(key, lookup);
  return lookup;
}

/**
 * Decide whether the browser may fetch the given URL.
 * Combines the structural SSRF checks from the shared validator with a fetch-time
 * DNS check so a rebound hostname is caught at the moment it matters.
 *
 * With `allowPrivateNetworks` set, the private-address blocking is intentionally lifted
 * (both the structural check and the DNS verdict), while scheme validation and per-request
 * DNS resolution stay active; see RequestGuardOptions.
 */
export async function checkRequestTarget(rawUrl: string, options: RequestGuardOptions = {}): Promise<TargetVerdict> {
  const { allowPrivateNetworks = false } = options;

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { allowed: false, reason: 'unparseable URL' };
  }

  // Scheme validation is enforced in every posture: only http(s) may ever be fetched.
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { allowed: false, reason: `disallowed protocol ${parsed.protocol}` };
  }

  // IP-literal hosts are decided without a DNS lookup; hostnames need a fresh DNS check at
  // request time to defeat rebinding.
  const hostname = parsed.hostname;
  const isIpLiteral = /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':');

  if (allowPrivateNetworks) {
    // Private-network scanning explicitly enabled: the structural SSRF block
    // (validateUrlSync's private/internal/loopback/link-local rules) is exactly what the
    // operator opted out of, so it is not applied. Scheme validation above and the
    // per-request DNS resolution below stay in force; a private IP literal here is simply
    // the internal host the operator asked to scan.
    if (isIpLiteral) {
      return { allowed: true };
    }
    return resolveHostVerdict(hostname, true);
  }

  // Default posture - unchanged SSRF blocking.
  const structural = validateUrlSync(rawUrl);
  if (!structural.valid) {
    return { allowed: false, reason: structural.error };
  }

  // IP-literal hosts are fully covered by the structural check; hostnames need a
  // fresh DNS check at request time to defeat rebinding.
  if (isIpLiteral) {
    return { allowed: true };
  }

  return resolveHostVerdict(hostname, false);
}

export interface RequestGuard {
  /** First request that triggered a scan-fatal block (main page only), if any. */
  readonly violation: { url: string; reason: string } | null;
  /**
   * Drain any in-flight redirect-hop validations, then throw BlockedRequestError if a
   * scan-fatal violation was recorded. Async because redirect checks run a DNS lookup off
   * the request event; awaiting them closes the race where a fast internal redirect's
   * capture returns before its (slower) verdict lands.
   */
  assertNoViolation(): Promise<void>;
}

/**
 * Attach the SSRF guard to a browser CONTEXT (not a single page) so popups / `target=_blank`
 * windows are guarded too - Playwright does not invoke a page-scoped route handler for a
 * popup's first navigation. Must be called before the first navigation.
 *
 * Scan-fatal violations (recorded in `violation`, surfaced by assertNoViolation):
 * - the MAIN page's main-frame navigation targets a private/internal host (aborted pre-request)
 * - a redirect hop on the MAIN page targets a private/internal host (page killed, results discarded)
 *
 * Subresource, iframe, and popup requests to private targets are aborted (or the popup page
 * is closed) without failing the scan, like an ad-blocker would.
 *
 * With `options.allowPrivateNetworks` set, private/internal targets are permitted (see
 * RequestGuardOptions); all other guarding - scheme checks, redirect-hop detection, and
 * per-request DNS resolution - is unchanged.
 */
export async function installRequestGuard(
  context: BrowserContext,
  mainPage: Page,
  log: Logger,
  options: RequestGuardOptions = {},
): Promise<RequestGuard> {
  const { allowPrivateNetworks = false } = options;
  let violation: { url: string; reason: string } | null = null;
  const pendingRedirectChecks: Promise<void>[] = [];

  const recordViolation = (url: string, reason: string) => {
    if (!violation) {
      violation = { url, reason };
    }
  };

  // True only for the main page's top-level navigation. Popups have their own main frame,
  // so their navigations are not scan-fatal (the request is still aborted).
  const isMainFrameRequest = (request: Request): boolean => {
    try {
      return request.frame() === mainPage.mainFrame();
    } catch {
      return false;
    }
  };

  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = request.url();

    let verdict: TargetVerdict;
    try {
      verdict = await checkRequestTarget(url, { allowPrivateNetworks });
    } catch (error) {
      verdict = {
        allowed: false,
        reason: `request guard error (${error instanceof Error ? error.message : String(error)})`,
      };
    }

    try {
      if (verdict.allowed) {
        await route.continue();
        return;
      }

      const reason = verdict.reason ?? 'blocked by request guard';
      if (request.isNavigationRequest() && isMainFrameRequest(request)) {
        recordViolation(url, reason);
        log.warn('Blocked main-frame navigation to disallowed target', { blockedUrl: url, reason });
      } else {
        // Subresource, iframe, or popup navigation - abort the request, keep scanning.
        log.warn('Blocked non-main request to disallowed target', { blockedUrl: url, reason });
      }
      await route.abort('blockedbyclient');
    } catch {
      // Page or context already closed - nothing to do.
    }
  });

  // Redirect hops bypass route handlers (Playwright only calls the handler for the first
  // URL in a redirect chain), so validate them here for every page in the context. The
  // request is already in flight; closing the offending page guarantees its response is
  // never captured or sent to the LLM. Each check is tracked so assertNoViolation can await
  // it - validating fire-and-forget would let a fast internal redirect's capture return
  // before a slow DNS verdict closes the page.
  context.on('request', (request) => {
    if (!request.redirectedFrom()) {
      return; // First request in a chain - already validated by the route handler.
    }

    const url = request.url();
    const check = checkRequestTarget(url, { allowPrivateNetworks })
      .then(async (verdict) => {
        if (verdict.allowed) {
          return;
        }
        const reason = verdict.reason ?? 'blocked by request guard';
        if (isMainFrameRequest(request)) {
          recordViolation(url, reason);
        }
        log.warn('Redirect to disallowed target - closing page', { blockedUrl: url, reason });

        let offendingPage: Page | null;
        try {
          offendingPage = request.frame().page();
        } catch {
          offendingPage = null;
        }
        await offendingPage?.close().catch(() => {});
      })
      .catch(() => {});
    pendingRedirectChecks.push(check);
  });

  return {
    get violation() {
      return violation;
    },
    async assertNoViolation() {
      // Drain redirect-hop validations before trusting that no violation occurred.
      await Promise.allSettled(pendingRedirectChecks);
      if (violation) {
        throw new BlockedRequestError(
          `Request to ${violation.url} was blocked for security reasons: ${violation.reason}`,
        );
      }
    },
  };
}
