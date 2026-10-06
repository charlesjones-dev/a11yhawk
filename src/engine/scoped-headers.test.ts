import { describe, expect, it, vi } from 'vitest';
import type { BrowserContext } from 'playwright';

import type { ScanHeader } from '../types.js';
import { installScopedHeaders, isTargetOrigin, partitionScanHeaders } from './scoped-headers.js';

const TARGET = 'https://app.example.com/dashboard';

const HEADERS: ScanHeader[] = [
  { type: 'authorization', key: 'Authorization', value: 'secret-token' },
  { type: 'header', key: 'X-Api-Key', value: 'secret-key' },
  { type: 'cookie', key: 'session', value: 'secret-session' },
];

// Mock context that captures the route handler, so tests can drive requests
// through it the way Playwright would.
function createMockContext() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let routeHandler: ((route: any) => Promise<void>) | null = null;
  const context = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    route: vi.fn(async (_pattern: string, handler: any) => {
      routeHandler = handler;
    }),
    addCookies: vi.fn().mockResolvedValue(undefined),
  };
  return {
    context,
    install: (headers: ScanHeader[] | undefined) =>
      installScopedHeaders(context as unknown as BrowserContext, TARGET, headers),
    /** Route one request and return the headers it would be sent with (undefined = unchanged). */
    routeRequest: async (url: string) => {
      const route = {
        request: () => ({ url: () => url, headers: () => ({ accept: '*/*' }) }),
        fallback: vi.fn().mockResolvedValue(undefined),
      };
      await routeHandler!(route);
      expect(route.fallback).toHaveBeenCalledTimes(1);
      const options = route.fallback.mock.calls[0]?.[0] as { headers?: Record<string, string> } | undefined;
      return options?.headers;
    },
  };
}

describe('isTargetOrigin', () => {
  const origin = new URL(TARGET).origin;

  it('matches the exact scheme, host, and port', () => {
    expect(isTargetOrigin('https://app.example.com/api/data?x=1', origin)).toBe(true);
    expect(isTargetOrigin('https://app.example.com:443/', origin)).toBe(true);
  });

  it('rejects third parties, subdomains, parent domains, other schemes, and other ports', () => {
    expect(isTargetOrigin('https://cdn.thirdparty.net/lib.js', origin)).toBe(false);
    expect(isTargetOrigin('https://static.app.example.com/app.js', origin)).toBe(false);
    expect(isTargetOrigin('https://example.com/', origin)).toBe(false);
    expect(isTargetOrigin('http://app.example.com/', origin)).toBe(false);
    expect(isTargetOrigin('https://app.example.com:8443/', origin)).toBe(false);
    expect(isTargetOrigin('https://app.example.com.evil.test/', origin)).toBe(false);
  });

  it('rejects unparseable URLs', () => {
    expect(isTargetOrigin('not a url', origin)).toBe(false);
  });
});

describe('partitionScanHeaders', () => {
  it('lowercases header names and formats the bearer token', () => {
    const { headers, cookies } = partitionScanHeaders(HEADERS);
    expect(headers).toEqual({ authorization: 'Bearer secret-token', 'x-api-key': 'secret-key' });
    expect(cookies).toEqual([{ name: 'session', value: 'secret-session' }]);
  });

  it('turns a Cookie header entry into cookies instead of a request header', () => {
    const { headers, cookies } = partitionScanHeaders([{ type: 'header', key: 'Cookie', value: 'a=1; b=two=2; ;bad' }]);
    expect(headers).toEqual({});
    expect(cookies).toEqual([
      { name: 'a', value: '1' },
      { name: 'b', value: 'two=2' },
    ]);
  });
});

describe('installScopedHeaders', () => {
  it('does nothing without custom headers', async () => {
    const env = createMockContext();
    await env.install(undefined);
    await env.install([]);
    expect(env.context.route).not.toHaveBeenCalled();
    expect(env.context.addCookies).not.toHaveBeenCalled();
  });

  it('sets cookies for the target URL only', async () => {
    const env = createMockContext();
    await env.install(HEADERS);
    expect(env.context.addCookies).toHaveBeenCalledWith([{ name: 'session', value: 'secret-session', url: TARGET }]);
  });

  it('adds the headers to same-origin requests', async () => {
    const env = createMockContext();
    await env.install(HEADERS);

    const sent = await env.routeRequest('https://app.example.com/api/data');
    expect(sent).toEqual({ accept: '*/*', authorization: 'Bearer secret-token', 'x-api-key': 'secret-key' });
  });

  it('does not add the headers to third-party or other-origin requests', async () => {
    const env = createMockContext();
    await env.install(HEADERS);

    for (const url of [
      'https://www.google-analytics.com/collect',
      'https://cdn.jsdelivr.net/npm/lib.js',
      'https://static.app.example.com/app.js',
      'http://app.example.com/insecure',
    ]) {
      expect(await env.routeRequest(url)).toBeUndefined();
    }
  });

  it('registers no route when only cookies are given', async () => {
    const env = createMockContext();
    await env.install([{ type: 'cookie', key: 'session', value: 's' }]);
    expect(env.context.route).not.toHaveBeenCalled();
    expect(env.context.addCookies).toHaveBeenCalledTimes(1);
  });
});
