import * as dns from 'dns/promises';
import { isIP } from 'node:net';

// Blocklist of dangerous hosts and patterns
const BLOCKED_HOSTS = [
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  '169.254.169.254', // AWS metadata
  'metadata.google.internal', // GCP metadata
];

// Defense-in-depth backstop for shell injection (security audit C-1).
// The validated URL (`url.href`) is later passed to the Lighthouse CLI as a process
// argument. The worker spawns Lighthouse WITHOUT a shell, so these characters cannot be
// interpreted as shell syntax - this check is a second line of defense that rejects the
// unambiguous shell command-construction markers at enqueue time, so a hostile URL never
// reaches the worker pipeline even if a future sink were to reintroduce a shell.
//
// We screen the normalized `url.href` (the exact string handed downstream) and block ONLY
// command-substitution constructs that have no legitimate place in an http(s) URL: `$(...)`,
// `${...}`, backticks, and ASCII control characters.
//
// We deliberately do NOT block characters that legitimately appear in real URLs - `&`/`=`
// (query separators), `+`, standalone parentheses (e.g. Wikipedia slugs), `*`, `!`, and
// notably `;` and `|` (matrix/path parameters and query data, e.g. `/products;color=red`).
// Percent-encoding those would change routing on servers that treat `;` as a matrix-param
// separator, making valid pages unscannable - and `shell: false` on the Lighthouse spawn
// already neutralizes them, so blocking them adds no real safety while causing false
// positives. WHATWG URL normalization additionally percent-encodes spaces, `<`, `>`, and
// backticks in the *path*, so those are neutralized before reaching this point.
const SHELL_METACHARACTER_PATTERNS = [
  /`/, // backtick command substitution (survives normalization in the query string)
  /\$[({]/, // `$(...)` command substitution and `${...}` parameter expansion
];

/**
 * Returns true if the value contains shell command-construction markers or ASCII control
 * characters. Used as a defense-in-depth backstop against shell injection (see comment on
 * SHELL_METACHARACTER_PATTERNS). `new URL()` normalization already strips/encodes most
 * control characters, so the control-character scan is belt-and-suspenders.
 */
function hasShellMetacharacters(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true; // ASCII control characters (newline, tab, NUL, DEL, ...)
  }
  return SHELL_METACHARACTER_PATTERNS.some((pattern) => pattern.test(value));
}

// Private and reserved IPv4 ranges (regex patterns). Covers RFC 1918 private space plus
// reserved/special-use ranges that have no legitimate public web presence - a URL or DNS
// answer pointing at any of these is either a misconfiguration or an SSRF attempt.
const PRIVATE_IPV4_PATTERNS = [
  /^10\./, // 10.0.0.0/8
  /^172\.(1[6-9]|2\d|3[01])\./, // 172.16.0.0/12
  /^192\.168\./, // 192.168.0.0/16
  /^127\./, // 127.0.0.0/8
  /^169\.254\./, // 169.254.0.0/16
  /^0\./, // 0.0.0.0/8 ("this network", includes 0.0.0.0)
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // 100.64.0.0/10 (carrier-grade NAT, often cloud-internal)
  /^192\.0\.0\./, // 192.0.0.0/24 (IETF protocol assignments)
  /^192\.0\.2\./, // 192.0.2.0/24 (TEST-NET-1)
  /^198\.1[89]\./, // 198.18.0.0/15 (benchmarking)
  /^198\.51\.100\./, // 198.51.100.0/24 (TEST-NET-2)
  /^203\.0\.113\./, // 203.0.113.0/24 (TEST-NET-3)
  /^2(2[4-9]|3\d)\./, // 224.0.0.0/4 (multicast)
  /^2(4\d|5[0-5])\./, // 240.0.0.0/4 (reserved, includes 255.255.255.255)
];

/**
 * Parse an IPv6 address (brackets, a zone ID, and a dotted IPv4 tail allowed) into its
 * eight 16-bit groups. Returns null when the text is not a valid IPv6 address.
 */
function parseIPv6Groups(input: string): number[] | null {
  let addr = input.replace(/^\[|\]$/g, '');
  const zone = addr.indexOf('%');
  if (zone !== -1) addr = addr.slice(0, zone);
  if (isIP(addr) !== 6) return null;

  // Rewrite a dotted IPv4 tail (::ffff:1.2.3.4) as two hex groups.
  const lastColon = addr.lastIndexOf(':');
  if (addr.includes('.', lastColon)) {
    const [a = 0, b = 0, c = 0, d = 0] = addr
      .slice(lastColon + 1)
      .split('.')
      .map(Number);
    addr = `${addr.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const [head = '', tail] = addr.split('::');
  const headGroups = head === '' ? [] : head.split(':');
  const tailGroups = tail === undefined || tail === '' ? [] : tail.split(':');
  const groups =
    tail === undefined
      ? headGroups
      : [...headGroups, ...Array<string>(8 - headGroups.length - tailGroups.length).fill('0'), ...tailGroups];
  return groups.length === 8 ? groups.map((group) => parseInt(group, 16)) : null;
}

/** Dotted IPv4 address held in two 16-bit groups. */
function embeddedIPv4(high: number, low: number): string {
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

/**
 * Checks if an IPv6 address is private, internal, or reserved. Handles addresses with or
 * without brackets. Prefixes that embed an IPv4 address (IPv4-mapped, NAT64 well-known,
 * 6to4) are judged by that address, so a public site reached through DNS64 still passes.
 * Returns false for anything without a colon (not IPv6); colon-bearing text that does not
 * parse is treated as private.
 */
function isPrivateIPv6(hostname: string): boolean {
  if (!hostname.includes(':')) return false;
  const g = parseIPv6Groups(hostname);
  if (!g) return true;
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g;

  // ::/96 - unspecified (::), loopback (::1), and deprecated IPv4-compatible (::a.b.c.d)
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return true;
  // ::ffff:0:0/96 - IPv4-mapped
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return isPrivateIPv4(embeddedIPv4(g6, g7));
  }
  // ::ffff:0:0:0/96 - IPv4-translated (RFC 2765)
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0xffff && g5 === 0) return true;
  // 64:ff9b::/96 - NAT64 well-known prefix (RFC 6052)
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isPrivateIPv4(embeddedIPv4(g6, g7));
  }
  // 64:ff9b:1::/48 - NAT64 local-use prefix (RFC 8215); the IPv4 position depends on the
  // operator's prefix length, so the whole range is refused.
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 1) return true;
  // 100::/64 - discard prefix (RFC 6666)
  if (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0) return true;
  // 2001::/23 - IETF protocol assignments: Teredo, benchmarking, ORCHID, and others
  if (g0 === 0x2001 && g1 < 0x200) return true;
  // 2001:db8::/32 - documentation
  if (g0 === 0x2001 && g1 === 0xdb8) return true;
  // 2002::/16 - 6to4, judged by the IPv4 address in the next 32 bits
  if (g0 === 0x2002) return isPrivateIPv4(embeddedIPv4(g1, g2));
  // 3fff::/20 - documentation (RFC 9637)
  if (g0 === 0x3fff && g1 < 0x1000) return true;
  // 5f00::/16 - SRv6 SIDs (RFC 9602)
  if (g0 === 0x5f00) return true;
  // fc00::/7 - unique local
  if ((g0 & 0xfe00) === 0xfc00) return true;
  // fe80::/10 - link-local
  if ((g0 & 0xffc0) === 0xfe80) return true;
  // fec0::/10 - site-local (deprecated)
  if ((g0 & 0xffc0) === 0xfec0) return true;
  // ff00::/8 - multicast
  if ((g0 & 0xff00) === 0xff00) return true;

  return false;
}

/**
 * Checks if an IPv4 address is private/internal
 */
function isPrivateIPv4(ip: string): boolean {
  return PRIVATE_IPV4_PATTERNS.some((pattern) => pattern.test(ip));
}

/**
 * Checks if a resolved IP address (IPv4 or IPv6) is private, internal, or reserved.
 * Used by the worker's request guard to re-check DNS answers at fetch time
 * (defense against DNS rebinding - see security audit H-1).
 */
export function isPrivateIpAddress(address: string): boolean {
  if (address.includes(':')) {
    return isPrivateIPv6(address);
  }
  return isPrivateIPv4(address);
}

// Returned for a hostname that resolves to a private address. Deliberately names no
// address: the message can reach whoever submitted the URL, who could otherwise map
// internal DNS names. The address travels separately as `resolvedAddress`, for logs.
const PRIVATE_RESOLUTION_ERROR = 'Domain resolves to a private or reserved IP address.';

/**
 * Validates that a hostname resolves to public IP addresses only.
 * This prevents DNS rebinding attacks where a domain initially resolves
 * to a public IP during validation, but then changes to a private IP
 * by the time the actual request is made.
 *
 * @param hostname - The hostname to validate
 * @returns Object with valid flag and optional error message
 */
async function validateDnsResolution(
  hostname: string,
): Promise<{ valid: boolean; error?: string; resolvedAddress?: string }> {
  // Skip DNS validation for IP addresses (already validated by other checks)
  // IPv4 check
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) {
    return { valid: true };
  }
  // IPv6 check (with or without brackets)
  if (hostname.includes(':')) {
    return { valid: true };
  }

  try {
    // Check IPv4 addresses
    try {
      const ipv4Addresses = await dns.resolve4(hostname);
      for (const addr of ipv4Addresses) {
        if (isPrivateIPv4(addr)) {
          return { valid: false, error: PRIVATE_RESOLUTION_ERROR, resolvedAddress: addr };
        }
      }
    } catch {
      // No IPv4 records is OK - might be IPv6 only
    }

    // Check IPv6 addresses
    try {
      const ipv6Addresses = await dns.resolve6(hostname);
      for (const addr of ipv6Addresses) {
        if (isPrivateIPv6(addr)) {
          return { valid: false, error: PRIVATE_RESOLUTION_ERROR, resolvedAddress: addr };
        }
      }
    } catch {
      // No IPv6 records is OK
    }

    return { valid: true };
  } catch {
    // DNS resolution completely failed - this could be a non-existent domain
    // Let the actual request fail later with a more descriptive error
    return { valid: true };
  }
}

/**
 * Synchronous URL validation that checks URL structure and patterns.
 * Does not perform DNS resolution - use validateUrl() for full validation.
 */
export function validateUrlSync(urlString: string): { valid: boolean; error?: string; url?: URL } {
  try {
    const url = new URL(urlString);

    // Check scheme - only allow http and https
    if (!['http:', 'https:'].includes(url.protocol)) {
      return { valid: false, error: `Invalid protocol: ${url.protocol}. Only HTTP and HTTPS are allowed.` };
    }

    // Check for blocked hostnames
    const hostname = url.hostname.toLowerCase();

    // For IPv6, url.hostname returns the address without brackets
    // Check both with and without brackets for IPv6
    if (BLOCKED_HOSTS.includes(hostname) || BLOCKED_HOSTS.includes(`[${hostname}]`)) {
      return { valid: false, error: 'Access to internal/private hosts is not allowed.' };
    }

    // Additional IPv6 localhost check (::1 and variations)
    if (hostname === '::1' || hostname === '[::1]') {
      return { valid: false, error: 'Access to internal/private hosts is not allowed.' };
    }

    // Check for private IPv4 ranges
    for (const pattern of PRIVATE_IPV4_PATTERNS) {
      if (pattern.test(hostname)) {
        return { valid: false, error: 'Access to private IP ranges is not allowed.' };
      }
    }

    // Check for private IPv6 addresses
    if (isPrivateIPv6(hostname)) {
      return { valid: false, error: 'Access to private IP ranges is not allowed.' };
    }

    // Check for suspicious patterns
    if (hostname.includes('localhost') || hostname.endsWith('.local')) {
      return { valid: false, error: 'Access to local domains is not allowed.' };
    }

    // Defense-in-depth: reject shell command-construction characters that survive URL
    // normalization (see hasShellMetacharacters). Screening `url.href` covers the userinfo,
    // host, path, query, and fragment - the entire string handed downstream to the worker.
    if (hasShellMetacharacters(url.href)) {
      return {
        valid: false,
        error: 'URL contains disallowed characters. Percent-encode special characters and try again.',
      };
    }

    return { valid: true, url };
  } catch {
    return { valid: false, error: 'Invalid URL format' };
  }
}

/**
 * Validates a URL for SSRF protection including DNS rebinding prevention.
 * This is the main validation function that should be used before fetching URLs.
 *
 * Performs:
 * 1. URL structure validation (protocol, format)
 * 2. Hostname/IP blocklist checking
 * 3. DNS resolution validation to prevent rebinding attacks
 *
 * @param urlString - The URL to validate
 * @returns Promise with validation result. `error` is safe to show the submitter;
 *   `resolvedAddress` (the private address a hostname resolved to) is for logs only.
 */
export async function validateUrl(
  urlString: string,
): Promise<{ valid: boolean; error?: string; url?: URL; resolvedAddress?: string }> {
  // First, perform synchronous validation
  const syncResult = validateUrlSync(urlString);
  if (!syncResult.valid) {
    return syncResult;
  }

  // Then perform DNS rebinding check
  const dnsResult = await validateDnsResolution(syncResult.url!.hostname);
  if (!dnsResult.valid) {
    return { valid: false, error: dnsResult.error, resolvedAddress: dnsResult.resolvedAddress };
  }

  return syncResult;
}
