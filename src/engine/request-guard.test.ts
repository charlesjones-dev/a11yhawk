import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Page } from 'playwright';

// Mock DNS so tests control what hostnames resolve to (no real network)
const mockLookup = vi.fn();
vi.mock('dns/promises', () => ({
  lookup: (...args: unknown[]) => mockLookup(...args),
  resolve4: vi.fn(),
  resolve6: vi.fn(),
}));

import { checkRequestTarget, clearDnsVerdictCache, installRequestGuard, BlockedRequestError } from './request-guard.js';

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

function dnsError(code: string): Error {
  return Object.assign(new Error(`DNS error ${code}`), { code });
}

beforeEach(() => {
  vi.clearAllMocks();
  clearDnsVerdictCache();
  mockLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Request Guard — checkRequestTarget', () => {
  describe('Allowed targets', () => {
    it('should allow a hostname that resolves to a public IP', async () => {
      const verdict = await checkRequestTarget('https://example.com/page');
      expect(verdict.allowed).toBe(true);
    });

    it('should allow a public IP literal without a DNS lookup', async () => {
      const verdict = await checkRequestTarget('https://93.184.216.34/');
      expect(verdict.allowed).toBe(true);
      expect(mockLookup).not.toHaveBeenCalled();
    });

    it('should fail open on ENOTFOUND so the browser reports its own resolution error', async () => {
      mockLookup.mockRejectedValue(dnsError('ENOTFOUND'));
      const verdict = await checkRequestTarget('https://does-not-exist.example.com/');
      expect(verdict.allowed).toBe(true);
    });
  });

  describe('Blocked targets — structural', () => {
    it('should block non-http(s) protocols', async () => {
      const verdict = await checkRequestTarget('ftp://example.com/');
      expect(verdict.allowed).toBe(false);
    });

    it('should block unparseable URLs', async () => {
      const verdict = await checkRequestTarget('not a url');
      expect(verdict.allowed).toBe(false);
    });

    it('should block loopback IP literals', async () => {
      const verdict = await checkRequestTarget('http://127.0.0.1:8080/admin');
      expect(verdict.allowed).toBe(false);
    });

    it('should block the cloud metadata endpoint', async () => {
      const verdict = await checkRequestTarget('http://169.254.169.254/latest/meta-data/');
      expect(verdict.allowed).toBe(false);
    });

    it('should block decimal-encoded IP literals (normalized by the URL parser)', async () => {
      // 2130706433 === 127.0.0.1; WHATWG URL parsing normalizes it to dotted decimal
      const verdict = await checkRequestTarget('http://2130706433/');
      expect(verdict.allowed).toBe(false);
    });

    it('should block IPv6 loopback literals', async () => {
      const verdict = await checkRequestTarget('http://[::1]/');
      expect(verdict.allowed).toBe(false);
    });

    it('should block reserved ranges (CGNAT, 0.0.0.0/8)', async () => {
      expect((await checkRequestTarget('http://100.64.0.1/')).allowed).toBe(false);
      expect((await checkRequestTarget('http://0.0.0.0/')).allowed).toBe(false);
    });
  });

  describe('Blocked targets — DNS rebinding', () => {
    it('should block a hostname that resolves to a private IPv4 address', async () => {
      mockLookup.mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);
      const verdict = await checkRequestTarget('https://rebind.evil.test/');
      expect(verdict.allowed).toBe(false);
      expect(verdict.reason).toContain('10.0.0.5');
    });

    it('should block a hostname that resolves to loopback', async () => {
      mockLookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
      const verdict = await checkRequestTarget('https://rebind.evil.test/');
      expect(verdict.allowed).toBe(false);
    });

    it('should block a hostname that resolves to a private IPv6 address', async () => {
      mockLookup.mockResolvedValue([{ address: '::1', family: 6 }]);
      const verdict = await checkRequestTarget('https://rebind6.evil.test/');
      expect(verdict.allowed).toBe(false);
    });

    it('should block when any of several resolved addresses is private', async () => {
      mockLookup.mockResolvedValue([
        { address: '93.184.216.34', family: 4 },
        { address: '192.168.1.10', family: 4 },
      ]);
      const verdict = await checkRequestTarget('https://multi.evil.test/');
      expect(verdict.allowed).toBe(false);
    });

    it('should fail closed on unexpected resolver errors', async () => {
      mockLookup.mockRejectedValue(dnsError('ESERVFAIL'));
      const verdict = await checkRequestTarget('https://flaky.example.com/');
      expect(verdict.allowed).toBe(false);
    });
  });

  describe('DNS re-resolution (no stale allow cache — Codex PR #77)', () => {
    it('should re-resolve on every sequential request rather than caching the allow verdict', async () => {
      await checkRequestTarget('https://example.com/a');
      await checkRequestTarget('https://example.com/b');
      expect(mockLookup).toHaveBeenCalledTimes(2);
    });

    it('should block a rebind to a private IP on a later request after an earlier allow', async () => {
      mockLookup.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]);
      const first = await checkRequestTarget('https://rebind.evil.test/');
      expect(first.allowed).toBe(true);

      // Same hostname, DNS flipped to loopback before the next fetch
      mockLookup.mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);
      const second = await checkRequestTarget('https://rebind.evil.test/');
      expect(second.allowed).toBe(false);
    });

    it('should coalesce only lookups that are in flight at the same instant', async () => {
      const [a, b] = await Promise.all([
        checkRequestTarget('https://example.com/a'),
        checkRequestTarget('https://example.com/b'),
      ]);
      expect(a.allowed).toBe(true);
      expect(b.allowed).toBe(true);
      expect(mockLookup).toHaveBeenCalledTimes(1);
    });
  });

  describe('allowPrivateNetworks option', () => {
    it('should permit a loopback IP literal when allowPrivateNetworks is true', async () => {
      const verdict = await checkRequestTarget('http://127.0.0.1:8080/admin', { allowPrivateNetworks: true });
      expect(verdict.allowed).toBe(true);
    });

    it('should permit a hostname that resolves to a private address when allowPrivateNetworks is true', async () => {
      mockLookup.mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);
      const verdict = await checkRequestTarget('https://internal.corp.test/', { allowPrivateNetworks: true });
      expect(verdict.allowed).toBe(true);
    });

    it('should still block a non-http(s) scheme even when allowPrivateNetworks is true', async () => {
      const verdict = await checkRequestTarget('ftp://127.0.0.1/', { allowPrivateNetworks: true });
      expect(verdict.allowed).toBe(false);
    });

    it('should still fail closed on unexpected resolver errors when allowPrivateNetworks is true', async () => {
      mockLookup.mockRejectedValue(dnsError('ESERVFAIL'));
      const verdict = await checkRequestTarget('https://flaky.internal.test/', { allowPrivateNetworks: true });
      expect(verdict.allowed).toBe(false);
    });
  });
});

describe('Request Guard — installRequestGuard', () => {
  type FrameKind = 'main' | 'iframe' | 'popup';

  interface MockRequestOptions {
    url: string;
    isNavigation?: boolean;
    frame?: FrameKind;
    redirectedFrom?: boolean;
  }

  // Builds a mock browser context with a main page, an iframe subframe of the main page,
  // and a separate popup page - so we can assert popup navigations are guarded at the
  // context level (Codex PR #77) and that only the main page's blocks are scan-fatal.
  function createMockEnv() {
    // Identity-stable frame objects so `request.frame() === mainPage.mainFrame()` works.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mainFrame: any = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const iframeFrame: any = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const popupFrame: any = {};

    const mainPage = { mainFrame: () => mainFrame, close: vi.fn().mockResolvedValue(undefined) };
    const popupPage = { mainFrame: () => popupFrame, close: vi.fn().mockResolvedValue(undefined) };

    mainFrame.page = () => mainPage;
    iframeFrame.page = () => mainPage; // subframe belongs to the main page
    popupFrame.page = () => popupPage;

    const frames: Record<FrameKind, unknown> = { main: mainFrame, iframe: iframeFrame, popup: popupFrame };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let routeHandler: ((route: any) => Promise<void>) | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const requestListeners: Array<(request: any) => void> = [];

    const context = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      route: vi.fn(async (_pattern: string, handler: any) => {
        routeHandler = handler;
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      on: vi.fn((event: string, listener: any) => {
        if (event === 'request') requestListeners.push(listener);
      }),
    };

    const makeRequest = (options: MockRequestOptions) => ({
      url: () => options.url,
      isNavigationRequest: () => options.isNavigation ?? false,
      frame: () => frames[options.frame ?? 'main'],
      redirectedFrom: () => (options.redirectedFrom ? makeRequest({ url: 'https://origin.example/' }) : null),
    });

    const makeRoute = (options: MockRequestOptions) => ({
      request: () => makeRequest(options),
      continue: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn().mockResolvedValue(undefined),
    });

    return {
      context,
      mainPage,
      popupPage,
      install: (options?: Parameters<typeof installRequestGuard>[3]) =>
        installRequestGuard(
          context as unknown as Parameters<typeof installRequestGuard>[0],
          mainPage as unknown as Page,
          mockLogger,
          options,
        ),
      routeRequest: (options: MockRequestOptions) => {
        const route = makeRoute(options);
        return routeHandler!(route).then(() => route);
      },
      emitRequest: (options: MockRequestOptions) => {
        for (const listener of requestListeners) listener(makeRequest(options));
      },
    };
  }

  async function flushAsync() {
    // Drain the microtask + macrotask queue so fire-and-forget handlers settle
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it('should register the guard on the context, not a single page', async () => {
    const env = createMockEnv();
    await env.install();
    expect(env.context.route).toHaveBeenCalledWith('**/*', expect.any(Function));
    expect(env.context.on).toHaveBeenCalledWith('request', expect.any(Function));
  });

  it('should continue requests to allowed targets', async () => {
    const env = createMockEnv();
    const guard = await env.install();

    const route = await env.routeRequest({ url: 'https://example.com/', isNavigation: true });

    expect(route.continue).toHaveBeenCalled();
    expect(route.abort).not.toHaveBeenCalled();
    expect(guard.violation).toBeNull();
  });

  it('should abort a main-frame navigation to a private target and record a violation', async () => {
    const env = createMockEnv();
    const guard = await env.install();

    const route = await env.routeRequest({ url: 'http://169.254.169.254/latest/meta-data/', isNavigation: true });

    expect(route.abort).toHaveBeenCalledWith('blockedbyclient');
    expect(guard.violation?.url).toBe('http://169.254.169.254/latest/meta-data/');
    await expect(guard.assertNoViolation()).rejects.toThrow(BlockedRequestError);
  });

  it('should abort a private subresource request without failing the scan', async () => {
    const env = createMockEnv();
    const guard = await env.install();

    const route = await env.routeRequest({ url: 'http://10.0.0.5/internal.png', isNavigation: false, frame: 'iframe' });

    expect(route.abort).toHaveBeenCalledWith('blockedbyclient');
    expect(guard.violation).toBeNull();
    await expect(guard.assertNoViolation()).resolves.toBeUndefined();
  });

  it('should abort a private iframe navigation without failing the scan', async () => {
    const env = createMockEnv();
    const guard = await env.install();

    const route = await env.routeRequest({ url: 'http://192.168.1.1/admin', isNavigation: true, frame: 'iframe' });

    expect(route.abort).toHaveBeenCalledWith('blockedbyclient');
    expect(guard.violation).toBeNull();
  });

  it('should abort a popup navigation to a private target without failing the scan (Codex PR #77)', async () => {
    const env = createMockEnv();
    const guard = await env.install();

    // A scanned page opening window.open('http://169.254.169.254/...') - the popup's first
    // navigation is caught because the guard is on the context, not the main page.
    const route = await env.routeRequest({
      url: 'http://169.254.169.254/latest/meta-data/',
      isNavigation: true,
      frame: 'popup',
    });

    expect(route.abort).toHaveBeenCalledWith('blockedbyclient');
    // Popup block is not scan-fatal - the SSRF request never left, but the main scan continues.
    expect(guard.violation).toBeNull();
    await expect(guard.assertNoViolation()).resolves.toBeUndefined();
  });

  it('should close the main page and record a violation when a redirect hop targets a private address', async () => {
    const env = createMockEnv();
    const guard = await env.install();

    env.emitRequest({ url: 'http://169.254.169.254/latest/meta-data/', frame: 'main', redirectedFrom: true });
    await flushAsync();

    expect(env.mainPage.close).toHaveBeenCalled();
    expect(guard.violation?.url).toBe('http://169.254.169.254/latest/meta-data/');
    await expect(guard.assertNoViolation()).rejects.toThrow(BlockedRequestError);
  });

  it('should close only the popup when a popup redirect hop targets a private address', async () => {
    const env = createMockEnv();
    const guard = await env.install();

    env.emitRequest({ url: 'http://10.0.0.1/admin', frame: 'popup', redirectedFrom: true });
    await flushAsync();

    expect(env.popupPage.close).toHaveBeenCalled();
    expect(env.mainPage.close).not.toHaveBeenCalled();
    expect(guard.violation).toBeNull();
  });

  it('should ignore redirect hops to allowed targets', async () => {
    const env = createMockEnv();
    const guard = await env.install();

    env.emitRequest({ url: 'https://example.com/destination', frame: 'main', redirectedFrom: true });
    await flushAsync();

    expect(env.mainPage.close).not.toHaveBeenCalled();
    expect(guard.violation).toBeNull();
  });

  it('should not re-validate first requests in the request listener (route handler covers them)', async () => {
    const env = createMockEnv();
    await env.install();
    mockLookup.mockClear();

    env.emitRequest({ url: 'https://example.com/', frame: 'main', redirectedFrom: false });
    await flushAsync();

    expect(mockLookup).not.toHaveBeenCalled();
  });

  it('should await in-flight redirect verdicts before asserting (no fire-and-forget race, Codex PR #77)', async () => {
    const env = createMockEnv();
    const guard = await env.install();

    // Redirect to a hostname that needs a DNS lookup which resolves to a private IP.
    mockLookup.mockResolvedValue([{ address: '10.0.0.7', family: 4 }]);
    env.emitRequest({ url: 'http://rebind.evil.test/', frame: 'main', redirectedFrom: true });

    // No manual flush: assertNoViolation must itself drain the pending redirect check.
    await expect(guard.assertNoViolation()).rejects.toThrow(BlockedRequestError);
    expect(env.mainPage.close).toHaveBeenCalled();
  });

  it('should continue a private target but still abort a non-http scheme when allowPrivateNetworks is true', async () => {
    const env = createMockEnv();
    const guard = await env.install({ allowPrivateNetworks: true });

    // With private-network scanning enabled, a loopback navigation is permitted.
    const allowed = await env.routeRequest({ url: 'http://127.0.0.1:8080/', isNavigation: true });
    expect(allowed.continue).toHaveBeenCalled();
    expect(allowed.abort).not.toHaveBeenCalled();

    // A non-http(s) scheme is still blocked - the option only relaxes private-address rules.
    const blocked = await env.routeRequest({ url: 'ftp://127.0.0.1/', isNavigation: true });
    expect(blocked.abort).toHaveBeenCalledWith('blockedbyclient');
    expect(guard.violation?.url).toBe('ftp://127.0.0.1/');
  });
});
