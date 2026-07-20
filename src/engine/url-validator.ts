import * as dns from 'dns/promises';

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
 * Checks if an IPv6 address is private/internal
 * Handles addresses both with and without brackets
 */
function isPrivateIPv6(hostname: string): boolean {
  // Remove brackets if present (URL parser gives us address without brackets)
  const addr = hostname.replace(/^\[|\]$/g, '').toLowerCase();

  // Skip if not IPv6
  if (!addr.includes(':')) return false;

  // Expand :: to full form for proper prefix matching
  // First, handle the special case of :: alone (all zeros)
  if (addr === '::') return true; // Unspecified address

  // fc00::/7 - Unique local addresses (fc00:: to fdff::)
  if (/^f[cd][0-9a-f]{0,2}:/i.test(addr)) return true;

  // fe80::/10 - Link-local addresses (fe80:: to febf::)
  if (/^fe[89ab][0-9a-f]:/i.test(addr) || /^fe80:/i.test(addr)) return true;

  // ::1 - Loopback (already handled in BLOCKED_HOSTS but be thorough)
  if (addr === '::1') return true;

  // ::ffff:x.x.x.x - IPv4-mapped IPv6 addresses
  // URL parser may convert dotted decimal to hex (e.g., ::ffff:c0a8:101 for 192.168.1.1)
  // Check for dotted decimal format first
  const ipv4MappedMatch = addr.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (ipv4MappedMatch && ipv4MappedMatch[1]) {
    const ipv4 = ipv4MappedMatch[1];
    return PRIVATE_IPV4_PATTERNS.some((pattern) => pattern.test(ipv4));
  }

  // Check for hex format (::ffff:XXXX:XXXX where XXXX are hex representations of IPv4 octets)
  const ipv4MappedHexMatch = addr.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (ipv4MappedHexMatch && ipv4MappedHexMatch[1] && ipv4MappedHexMatch[2]) {
    const high = parseInt(ipv4MappedHexMatch[1], 16);
    const low = parseInt(ipv4MappedHexMatch[2], 16);
    // Convert back to dotted decimal
    const ipv4 = `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
    return PRIVATE_IPV4_PATTERNS.some((pattern) => pattern.test(ipv4));
  }

  // 100::/64 - Discard prefix (RFC 6666)
  if (/^100::/i.test(addr)) return true;

  // 2001:db8::/32 - Documentation range
  if (/^2001:db8:/i.test(addr)) return true;

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

/**
 * Validates that a hostname resolves to public IP addresses only.
 * This prevents DNS rebinding attacks where a domain initially resolves
 * to a public IP during validation, but then changes to a private IP
 * by the time the actual request is made.
 *
 * @param hostname - The hostname to validate
 * @returns Object with valid flag and optional error message
 */
async function validateDnsResolution(hostname: string): Promise<{ valid: boolean; error?: string }> {
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
          return {
            valid: false,
            error: `Domain resolves to private IP address (${addr})`,
          };
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
          return {
            valid: false,
            error: `Domain resolves to private IPv6 address (${addr})`,
          };
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
 * @returns Promise with validation result
 */
export async function validateUrl(urlString: string): Promise<{ valid: boolean; error?: string; url?: URL }> {
  // First, perform synchronous validation
  const syncResult = validateUrlSync(urlString);
  if (!syncResult.valid) {
    return syncResult;
  }

  // Then perform DNS rebinding check
  const dnsResult = await validateDnsResolution(syncResult.url!.hostname);
  if (!dnsResult.valid) {
    return { valid: false, error: dnsResult.error };
  }

  return syncResult;
}
