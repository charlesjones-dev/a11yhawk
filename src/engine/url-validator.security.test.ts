/**
 * Security regression tests for address classification: IPv6 literals in reserved ranges
 * (embedded-IPv4, NAT64, 6to4, site-local, multicast, ...) are refused by the structural
 * check and the request guard with no DNS lookup, DNS answers get the same classification,
 * and refusal messages never name the private address a hostname resolved to.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const lookup = vi.fn();
const resolve4 = vi.fn();
const resolve6 = vi.fn();
vi.mock('dns/promises', () => ({
  lookup: (...args: unknown[]) => lookup(...args),
  resolve4: (...args: unknown[]) => resolve4(...args),
  resolve6: (...args: unknown[]) => resolve6(...args),
}));

import { checkRequestTarget } from './request-guard.js';
import { isPrivateIpAddress, validateUrl, validateUrlSync } from './url-validator.js';

const NO_RECORDS = Object.assign(new Error('ENODATA'), { code: 'ENODATA' });

beforeEach(() => {
  lookup.mockReset();
  resolve4.mockReset().mockRejectedValue(NO_RECORDS);
  resolve6.mockReset().mockRejectedValue(NO_RECORDS);
});

describe('reserved IPv6 literals', () => {
  const blocked: Array<{ url: string; what: string }> = [
    { url: 'http://[::127.0.0.1]/', what: 'IPv4-compatible 127.0.0.1, dotted' },
    { url: 'http://[::7f00:1]/', what: 'IPv4-compatible 127.0.0.1, hex' },
    { url: 'http://[64:ff9b::7f00:1]/', what: 'NAT64 well-known prefix, 127.0.0.1' },
    { url: 'http://[64:ff9b::a9fe:a9fe]/', what: 'NAT64 well-known prefix, 169.254.169.254' },
    { url: 'http://[64:ff9b:1::a9fe:a9fe]/', what: 'NAT64 local-use prefix' },
    { url: 'http://[2002:7f00:1::]/', what: '6to4 embedding 127.0.0.1' },
    { url: 'http://[2002:a00:1::1]/', what: '6to4 embedding 10.0.0.1' },
    { url: 'http://[fec0::1]/', what: 'site-local' },
    { url: 'http://[ff02::1]/', what: 'multicast' },
    { url: 'http://[::ffff:0:7f00:1]/', what: 'IPv4-translated' },
    { url: 'http://[2001::1]/', what: 'Teredo' },
    { url: 'http://[2001:2::1]/', what: 'benchmarking' },
    { url: 'http://[2001:10::1]/', what: 'ORCHID' },
    { url: 'http://[3fff::1]/', what: 'documentation (RFC 9637)' },
    { url: 'http://[5f00::1]/', what: 'SRv6 SIDs' },
  ];
  for (const { url, what } of blocked) {
    it(`blocks ${url} (${what}) without a DNS lookup`, async () => {
      expect(validateUrlSync(url).valid).toBe(false);
      expect((await checkRequestTarget(url)).allowed).toBe(false);
      expect(lookup).not.toHaveBeenCalled();
    });
  }

  const allowed: Array<{ url: string; what: string }> = [
    { url: 'http://[2606:4700:4700::1111]/', what: 'global unicast' },
    { url: 'http://[2001:4860:4860::8888]/', what: 'global unicast outside 2001::/23' },
    { url: 'http://[64:ff9b::5db8:d822]/', what: 'NAT64 embedding a public address (DNS64)' },
    { url: 'http://[::ffff:5db8:d822]/', what: 'IPv4-mapped public address' },
    { url: 'http://[2002:5db8:d822::1]/', what: '6to4 embedding a public address' },
  ];
  for (const { url, what } of allowed) {
    it(`allows ${url} (${what})`, async () => {
      expect(validateUrlSync(url).valid).toBe(true);
      expect((await checkRequestTarget(url)).allowed).toBe(true);
    });
  }
});

describe('DNS answers', () => {
  it('classifies embedded-IPv4, NAT64, and scoped link-local answers as private', () => {
    expect(isPrivateIpAddress('::7f00:1')).toBe(true);
    expect(isPrivateIpAddress('64:ff9b::7f00:1')).toBe(true);
    expect(isPrivateIpAddress('fe80::1%en0')).toBe(true);
    expect(isPrivateIpAddress('64:ff9b::5db8:d822')).toBe(false);
  });

  it('blocks a hostname whose fresh lookup returns a NAT64 address of the metadata service', async () => {
    lookup.mockResolvedValue([{ address: '64:ff9b::a9fe:a9fe', family: 6 }]);
    expect((await checkRequestTarget('http://rebind.test/')).allowed).toBe(false);
  });

  it('rejects a scan URL whose AAAA record is IPv4-compatible loopback', async () => {
    resolve6.mockResolvedValue(['::7f00:1']);
    expect((await validateUrl('http://internal.test/')).valid).toBe(false);
  });
});

describe('refusal messages do not name the resolved address', () => {
  it('validateUrl keeps a private A record out of the error', async () => {
    resolve4.mockResolvedValue(['10.20.30.40']);
    const result = await validateUrl('http://intranet.test/');
    expect(result.valid).toBe(false);
    expect(result.error).not.toContain('10.20.30.40');
    expect(result.resolvedAddress).toBe('10.20.30.40');
  });

  it('validateUrl keeps a private AAAA record out of the error', async () => {
    resolve6.mockResolvedValue(['fd12:3456::1']);
    const result = await validateUrl('http://intranet.test/');
    expect(result.valid).toBe(false);
    expect(result.error).not.toContain('fd12:3456::1');
    expect(result.resolvedAddress).toBe('fd12:3456::1');
  });

  it('the request guard keeps the address out of the reason', async () => {
    lookup.mockResolvedValue([{ address: '10.20.30.40', family: 4 }]);
    const verdict = await checkRequestTarget('http://intranet.test/');
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).not.toContain('10.20.30.40');
    expect(verdict.resolvedAddress).toBe('10.20.30.40');
  });
});

describe('earlier bypass attempts stay blocked', () => {
  const blocked = [
    'http://2130706433/',
    'http://0x7f000001/',
    'http://0177.0.0.1/',
    'http://127.1/',
    'http://0.0.0.0/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:7f00:1]/',
    'http://[0:0:0:0:0:ffff:127.0.0.1]/',
    'http://[::ffff:a9fe:a9fe]/',
    'http://[::]/',
    'http://[::1]/',
    'http://[fe80::1]/',
    'http://[fd00::1]/',
    'http://localhost./',
    'http://foo.localhost/',
    'http://169.254.169.254.nip.io/',
    'http://metadata.google.internal/',
    'file:///etc/hosts',
    'gopher://127.0.0.1/',
  ];
  for (const url of blocked) {
    it(`blocks ${url}`, async () => {
      expect((await checkRequestTarget(url)).allowed).toBe(false);
    });
  }

  it('blocks a hostname whose fresh lookup returns a private answer among public ones', async () => {
    lookup.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '169.254.169.254', family: 4 },
    ]);
    expect((await checkRequestTarget('http://rebind.test/')).allowed).toBe(false);
  });

  it('blocks a hostname whose lookup returns an IPv4-mapped loopback', async () => {
    lookup.mockResolvedValue([{ address: '::ffff:127.0.0.1', family: 6 }]);
    expect((await checkRequestTarget('http://rebind.test/')).allowed).toBe(false);
  });
});
