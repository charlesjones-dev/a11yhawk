/**
 * Log Sanitization Utilities
 *
 * Provides functions to sanitize sensitive data from log entries
 * before they are sent to external logging services.
 *
 * Sanitizes:
 * - API keys (OpenRouter, Anthropic, OpenAI patterns)
 * - Bearer tokens
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

  let sanitized = str;

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
