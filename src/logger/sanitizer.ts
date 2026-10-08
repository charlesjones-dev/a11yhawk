/**
 * Log Sanitization Utilities
 *
 * Provides functions to sanitize sensitive data from log entries
 * before they are sent to external logging services.
 *
 * Sanitizes:
 * - API keys (OpenRouter, Anthropic, OpenAI patterns)
 * - Bearer tokens
 * - URL credentials: userinfo and token-like query values
 * - Database connection strings (MongoDB, Redis)
 * - Generic secrets and passwords
 *
 * Preserves:
 * - Business identifiers (jobId, scanId, userId, projectId, etc.)
 * - Non-sensitive metadata
 */

/**
 * Placeholder for masked values
 */
const MASK = '[REDACTED]';

/**
 * Sensitive field names that should always be masked
 */
const SENSITIVE_FIELDS = new Set([
  'password',
  'secret',
  'apikey',
  'api_key',
  'apiKey',
  'token',
  'authorization',
  'auth',
  'credential',
  'credentials',
  'privatekey',
  'private_key',
  'privateKey',
  'encryptedapikey',
  'encrypted_api_key',
  'encryptedApiKey',
  'encryptedheaders',
  'encrypted_headers',
  'encryptedHeaders',
  'accesstoken',
  'access_token',
  'accessToken',
  'refreshtoken',
  'refresh_token',
  'refreshToken',
  'bearertoken',
  'bearer_token',
  'bearerToken',
  'sessiontoken',
  'session_token',
  'sessionToken',
  'cookie',
  'cookies',
  'byokkey',
  'byok_key',
  'byokKey',
]);

/**
 * Business identifier fields that should be preserved
 */
const PRESERVED_FIELDS = new Set([
  'jobId',
  'scanId',
  'userId',
  'projectId',
  'scheduleId',
  'batchId',
  'teamId',
  'requestId',
  'id',
  '_id',
]);

/**
 * Regular expressions for detecting sensitive patterns in strings
 */
const SENSITIVE_PATTERNS: Array<{ pattern: RegExp; name: string; isConnectionString?: boolean }> = [
  // OpenRouter API keys (sk-or-v1-...)
  { pattern: /sk-or-v1-[a-zA-Z0-9]{32,}/g, name: 'OpenRouter API key' },

  // Anthropic API keys (sk-ant-api...)
  { pattern: /sk-ant-api[a-zA-Z0-9_-]{20,}/g, name: 'Anthropic API key' },
  { pattern: /sk-ant-[a-zA-Z0-9_-]{20,}/g, name: 'Anthropic API key' },

  // OpenAI API keys (sk-proj-..., sk-...)
  { pattern: /sk-proj-[a-zA-Z0-9_-]{20,}/g, name: 'OpenAI project key' },
  { pattern: /sk-[a-zA-Z0-9]{20,}/g, name: 'OpenAI API key' },

  // Generic API key patterns
  { pattern: /key-[a-zA-Z0-9]{16,}/g, name: 'Generic API key' },
  { pattern: /api[-_]?key[=:]["']?[a-zA-Z0-9_-]{16,}["']?/gi, name: 'API key assignment' },

  // Bearer tokens
  { pattern: /Bearer\s+[a-zA-Z0-9_.-]{20,}/gi, name: 'Bearer token' },

  // MongoDB connection strings (mask password) - capture groups: $1=+srv, $2=username, $3=password, $4=host
  {
    pattern: /mongodb(\+srv)?:\/\/([^:]+):([^@]+)@([^/\s]+)/gi,
    name: 'MongoDB connection string',
    isConnectionString: true,
  },

  // Redis connection strings (mask password) - capture groups: $1=s, $2=username, $3=password, $4=host
  {
    pattern: /redis(s)?:\/\/([^:]+):([^@]+)@([^/\s]+)/gi,
    name: 'Redis connection string',
    isConnectionString: true,
  },

  // AWS keys
  { pattern: /AKIA[0-9A-Z]{16}/g, name: 'AWS access key' },

  // JWT tokens (three base64 segments separated by dots)
  { pattern: /eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g, name: 'JWT token' },

  // Hex-encoded secrets (32+ characters, likely encryption keys)
  { pattern: /[a-fA-F0-9]{64,}/g, name: 'Hex-encoded secret' },
];

// http(s), ws(s), and ftp URLs, which reach the logs whole (scan targets, blocked requests).
// A fixed scheme list keeps the scan linear: no unbounded run precedes the literal "://".
// Apostrophes are valid URL characters (userinfo included), so only whitespace, `"`, `<`,
// and `>` end a URL; a closing quote right after a credential value is masked with it.
const URL_PATTERN = /\b(?:https?|wss?|ftp):\/\/[^\s"<>]+/gi;

// Query and fragment parameter names whose values are credentials, tested on the decoded
// name with everything but letters and digits removed (`X-Amz-Signature`, `api_key`,
// `user[password]`, `to%6Ben`): anything ending in token, secret, password, signature,
// credential, api key, access key, session id, or auth, plus a few short names.
const SENSITIVE_PARAM =
  /(?:token|secret|passw(?:or)?d|signature|credential|apikey|accesskey|sess(?:ion)?(?:id)?|auth(?:orization)?)$|^(?:key|sig|code|jwt|pass|pwd)$/i;

function isSensitiveParam(name: string): boolean {
  let decoded = name;
  try {
    decoded = decodeURIComponent(name);
  } catch {
    // Malformed escape: test the raw name.
  }
  return SENSITIVE_PARAM.test(decoded.replace(/[^a-z0-9]/gi, ''));
}

/** Mask the values of credential-like parameters in one URL section. */
function maskParams(section: string, pattern: RegExp): string {
  return section.replace(pattern, (match, separator: string, name: string, value: string) =>
    value !== '' && isSensitiveParam(name) ? `${separator}${name}=${MASK}` : match,
  );
}

/**
 * Mask a URL's userinfo (everything up to the last `@` before the path) and the values of
 * credential-like parameters. Each section splits parameters the way URL parsing does, so
 * a value is masked whole: query and fragment parameters end only at `&` (a `;` or a later
 * `#` stays inside the value; OAuth puts tokens in the fragment), and path parameters such
 * as `;jsessionid=` end at `;` or `/`.
 */
function maskUrlCredentials(url: string): string {
  const masked = url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@/i, `$1${MASK}@`);
  const hash = masked.indexOf('#');
  const beforeHash = hash === -1 ? masked : masked.slice(0, hash);
  const query = beforeHash.indexOf('?');
  const path = query === -1 ? beforeHash : beforeHash.slice(0, query);
  return (
    maskParams(path, /(;)([^=;/]*)=([^;/]*)/g) +
    maskParams(query === -1 ? '' : beforeHash.slice(query), /([?&])([^=&]*)=([^&]*)/g) +
    maskParams(hash === -1 ? '' : masked.slice(hash), /([#&])([^=&]*)=([^&]*)/g)
  );
}

/**
 * Sanitize a string value by masking sensitive patterns
 *
 * @param str - The string to sanitize
 * @returns Sanitized string with sensitive data masked
 *
 * @example
 * ```typescript
 * sanitizeString('API key: sk-or-v1-abc123...')
 * // Returns: 'API key: [REDACTED]'
 * ```
 */
export function sanitizeString(str: string): string {
  if (!str || typeof str !== 'string') {
    return str;
  }

  let sanitized = str.replace(URL_PATTERN, maskUrlCredentials);

  for (const { pattern, isConnectionString } of SENSITIVE_PATTERNS) {
    // Reset regex state (important for global regexes)
    pattern.lastIndex = 0;

    if (isConnectionString) {
      // Special handling for connection strings - mask only password portion
      // MongoDB pattern groups: $1=+srv or undefined, $2=username, $3=password, $4=host
      // Redis pattern groups: $1=s or undefined, $2=username, $3=password, $4=host
      if (pattern.source.includes('mongodb')) {
        sanitized = sanitized.replace(pattern, (_match, srv, username, _password, host) => {
          return `mongodb${srv || ''}://${username}:${MASK}@${host}`;
        });
      } else if (pattern.source.includes('redis')) {
        sanitized = sanitized.replace(pattern, (_match, s, username, _password, host) => {
          return `redis${s || ''}://${username}:${MASK}@${host}`;
        });
      }
    } else {
      sanitized = sanitized.replace(pattern, MASK);
    }
  }

  return sanitized;
}

/**
 * Check if a field name indicates sensitive data
 */
function isSensitiveField(fieldName: string): boolean {
  const normalized = fieldName.toLowerCase().replace(/[-_]/g, '');
  return SENSITIVE_FIELDS.has(normalized) || SENSITIVE_FIELDS.has(fieldName.toLowerCase());
}

/**
 * Check if a field should be preserved (business identifiers)
 */
function isPreservedField(fieldName: string): boolean {
  return PRESERVED_FIELDS.has(fieldName);
}

/**
 * Deep clone and sanitize an object, masking sensitive values
 *
 * @param obj - The object to sanitize (will be deep-cloned)
 * @returns A new sanitized object
 *
 * @example
 * ```typescript
 * sanitize({
 *   jobId: 'job123',
 *   apiKey: 'sk-or-v1-secret123',
 *   url: 'mongodb://user:password@host'
 * })
 * // Returns: {
 * //   jobId: 'job123',
 * //   apiKey: '[REDACTED]',
 * //   url: 'mongodb://user:[REDACTED]@host'
 * // }
 * ```
 */
export function sanitize(obj: unknown): unknown {
  // Handle null/undefined
  if (obj === null || obj === undefined) {
    return obj;
  }

  // Handle primitives
  if (typeof obj === 'string') {
    return sanitizeString(obj);
  }

  if (typeof obj === 'number' || typeof obj === 'boolean') {
    return obj;
  }

  // Handle arrays
  if (Array.isArray(obj)) {
    return obj.map((item) => sanitize(item));
  }

  // Handle Date objects
  if (obj instanceof Date) {
    return obj;
  }

  // Handle Error objects
  if (obj instanceof Error) {
    return {
      name: obj.name,
      message: sanitizeString(obj.message),
      stack: obj.stack ? sanitizeString(obj.stack) : undefined,
    };
  }

  // Handle plain objects
  if (typeof obj === 'object') {
    const sanitized: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      // Preserve business identifiers
      if (isPreservedField(key)) {
        sanitized[key] = value;
        continue;
      }

      // Mask sensitive fields entirely
      if (isSensitiveField(key)) {
        sanitized[key] = MASK;
        continue;
      }

      // Recursively sanitize other fields
      sanitized[key] = sanitize(value);
    }

    return sanitized;
  }

  // Return unknown types as-is
  return obj;
}

/**
 * Sanitize an Error object for logging
 *
 * @param error - The error to sanitize
 * @returns Sanitized error object safe for logging
 */
export function sanitizeError(error: Error): { name: string; message: string; stack?: string } {
  return {
    name: error.name,
    message: sanitizeString(error.message),
    stack: error.stack ? sanitizeString(error.stack) : undefined,
  };
}

/**
 * Get the mask placeholder value (for testing)
 */
export function getMaskPlaceholder(): string {
  return MASK;
}
