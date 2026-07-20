import { describe, it, expect } from 'vitest';
import { sanitize, sanitizeString, sanitizeError, getMaskPlaceholder } from './sanitizer.js';

const MASK = getMaskPlaceholder();

describe('Log Sanitizer', () => {
  describe('sanitizeString', () => {
    describe('OpenRouter API keys', () => {
      it('masks sk-or-v1-* patterns', () => {
        const input = 'API key: sk-or-v1-abcdef1234567890abcdef1234567890';
        const result = sanitizeString(input);
        expect(result).toBe(`API key: ${MASK}`);
      });

      it('masks multiple OpenRouter keys in same string', () => {
        const input = 'Keys: sk-or-v1-abc123abc123abc123abc123abc123ab and sk-or-v1-def456def456def456def456def456de';
        const result = sanitizeString(input);
        expect(result).toBe(`Keys: ${MASK} and ${MASK}`);
      });
    });

    describe('Anthropic API keys', () => {
      it('masks sk-ant-api* patterns', () => {
        const input = 'Using sk-ant-api03-abcdef1234567890abcd';
        const result = sanitizeString(input);
        expect(result).toBe(`Using ${MASK}`);
      });

      it('masks sk-ant-* patterns', () => {
        const input = 'Key is sk-ant-admin01-abcdef1234567890';
        const result = sanitizeString(input);
        expect(result).toBe(`Key is ${MASK}`);
      });
    });

    describe('OpenAI API keys', () => {
      it('masks sk-proj-* patterns', () => {
        const input = 'OpenAI key: sk-proj-abcdef1234567890abcd';
        const result = sanitizeString(input);
        expect(result).toBe(`OpenAI key: ${MASK}`);
      });

      it('masks generic sk-* patterns (20+ chars)', () => {
        const input = 'Key: sk-abcdef1234567890abcd';
        const result = sanitizeString(input);
        expect(result).toBe(`Key: ${MASK}`);
      });

      it('does not mask short sk-* patterns', () => {
        const input = 'Key: sk-short';
        const result = sanitizeString(input);
        expect(result).toBe('Key: sk-short');
      });
    });

    describe('Bearer tokens', () => {
      it('masks Bearer tokens', () => {
        const input = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9';
        const result = sanitizeString(input);
        expect(result).toBe(`Authorization: ${MASK}`);
      });

      it('masks bearer tokens case-insensitively', () => {
        const input = 'header: bearer abc123def456ghi789jkl012';
        const result = sanitizeString(input);
        expect(result).toBe(`header: ${MASK}`);
      });
    });

    describe('MongoDB connection strings', () => {
      it('masks password in MongoDB connection string', () => {
        const input = 'mongodb://user:secretpassword@localhost:27017/database';
        const result = sanitizeString(input);
        expect(result).toBe(`mongodb://user:${MASK}@localhost:27017/database`);
      });

      it('masks password in MongoDB+SRV connection string', () => {
        const input = 'mongodb+srv://admin:supersecret@cluster.mongodb.net/db';
        const result = sanitizeString(input);
        expect(result).toBe(`mongodb+srv://admin:${MASK}@cluster.mongodb.net/db`);
      });
    });

    describe('Redis connection strings', () => {
      it('masks password in Redis connection string', () => {
        const input = 'redis://default:myredispassword@redis.example.com:6379';
        const result = sanitizeString(input);
        expect(result).toBe(`redis://default:${MASK}@redis.example.com:6379`);
      });

      it('masks password in rediss (TLS) connection string', () => {
        const input = 'rediss://user:tlspassword@redis.example.com:6380';
        const result = sanitizeString(input);
        expect(result).toBe(`rediss://user:${MASK}@redis.example.com:6380`);
      });
    });

    describe('Generic sensitive patterns', () => {
      it('masks key-* patterns', () => {
        const input = 'Using key-abcdef1234567890ab';
        const result = sanitizeString(input);
        expect(result).toBe(`Using ${MASK}`);
      });

      it('masks JWT tokens', () => {
        const jwt =
          'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
        const input = `Token: ${jwt}`;
        const result = sanitizeString(input);
        expect(result).toBe(`Token: ${MASK}`);
      });

      it('masks AWS access keys', () => {
        const input = 'AWS key: AKIAIOSFODNN7EXAMPLE';
        const result = sanitizeString(input);
        expect(result).toBe(`AWS key: ${MASK}`);
      });

      it('masks long hex strings (encryption keys)', () => {
        const hexKey = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
        const input = `Secret: ${hexKey}`;
        const result = sanitizeString(input);
        expect(result).toBe(`Secret: ${MASK}`);
      });
    });

    describe('edge cases', () => {
      it('handles null input', () => {
        expect(sanitizeString(null as unknown as string)).toBeNull();
      });

      it('handles undefined input', () => {
        expect(sanitizeString(undefined as unknown as string)).toBeUndefined();
      });

      it('handles empty string', () => {
        expect(sanitizeString('')).toBe('');
      });

      it('handles non-string input', () => {
        expect(sanitizeString(123 as unknown as string)).toBe(123);
      });

      it('preserves non-sensitive strings', () => {
        const input = 'This is a normal log message with userId: user123';
        expect(sanitizeString(input)).toBe(input);
      });
    });
  });

  describe('sanitize (deep object sanitization)', () => {
    describe('preserves business identifiers', () => {
      it('preserves jobId', () => {
        const obj = { jobId: 'job-123-abc' };
        const result = sanitize(obj);
        expect(result).toEqual({ jobId: 'job-123-abc' });
      });

      it('preserves scanId', () => {
        const obj = { scanId: 'scan-456-def' };
        const result = sanitize(obj);
        expect(result).toEqual({ scanId: 'scan-456-def' });
      });

      it('preserves userId', () => {
        const obj = { userId: 'user-789-ghi' };
        const result = sanitize(obj);
        expect(result).toEqual({ userId: 'user-789-ghi' });
      });

      it('preserves projectId', () => {
        const obj = { projectId: 'proj-012-jkl' };
        const result = sanitize(obj);
        expect(result).toEqual({ projectId: 'proj-012-jkl' });
      });

      it('preserves scheduleId', () => {
        const obj = { scheduleId: 'sched-345-mno' };
        const result = sanitize(obj);
        expect(result).toEqual({ scheduleId: 'sched-345-mno' });
      });

      it('preserves batchId', () => {
        const obj = { batchId: 'batch-678-pqr' };
        const result = sanitize(obj);
        expect(result).toEqual({ batchId: 'batch-678-pqr' });
      });

      it('preserves teamId', () => {
        const obj = { teamId: 'team-901-stu' };
        const result = sanitize(obj);
        expect(result).toEqual({ teamId: 'team-901-stu' });
      });

      it('preserves requestId', () => {
        const obj = { requestId: 'req-234-vwx' };
        const result = sanitize(obj);
        expect(result).toEqual({ requestId: 'req-234-vwx' });
      });

      it('preserves multiple business identifiers together', () => {
        const obj = {
          jobId: 'job-123',
          scanId: 'scan-456',
          userId: 'user-789',
          projectId: 'proj-012',
        };
        const result = sanitize(obj);
        expect(result).toEqual(obj);
      });
    });

    describe('masks sensitive fields', () => {
      it('masks apiKey field', () => {
        const obj = { apiKey: 'sk-or-v1-secret123' };
        const result = sanitize(obj);
        expect(result).toEqual({ apiKey: MASK });
      });

      it('masks password field', () => {
        const obj = { password: 'supersecret123' };
        const result = sanitize(obj);
        expect(result).toEqual({ password: MASK });
      });

      it('masks token field', () => {
        const obj = { token: 'abc123token' };
        const result = sanitize(obj);
        expect(result).toEqual({ token: MASK });
      });

      it('masks authorization field', () => {
        const obj = { authorization: 'Bearer abc123' };
        const result = sanitize(obj);
        expect(result).toEqual({ authorization: MASK });
      });

      it('masks cookie field', () => {
        const obj = { cookie: 'session=abc123' };
        const result = sanitize(obj);
        expect(result).toEqual({ cookie: MASK });
      });

      it('masks encryptedApiKey field', () => {
        const obj = { encryptedApiKey: 'iv:ciphertext:tag' };
        const result = sanitize(obj);
        expect(result).toEqual({ encryptedApiKey: MASK });
      });

      it('masks accessToken field', () => {
        const obj = { accessToken: 'access-token-value' };
        const result = sanitize(obj);
        expect(result).toEqual({ accessToken: MASK });
      });

      it('masks refreshToken field', () => {
        const obj = { refreshToken: 'refresh-token-value' };
        const result = sanitize(obj);
        expect(result).toEqual({ refreshToken: MASK });
      });
    });

    describe('deep object sanitization', () => {
      it('sanitizes nested objects', () => {
        const obj = {
          user: {
            id: 'user-123',
            apiKey: 'sk-or-v1-secret',
          },
        };
        const result = sanitize(obj);
        expect(result).toEqual({
          user: {
            id: 'user-123',
            apiKey: MASK,
          },
        });
      });

      it('sanitizes deeply nested objects', () => {
        const obj = {
          level1: {
            level2: {
              level3: {
                password: 'secret',
                userId: 'user-123',
              },
            },
          },
        };
        const result = sanitize(obj);
        expect(result).toEqual({
          level1: {
            level2: {
              level3: {
                password: MASK,
                userId: 'user-123',
              },
            },
          },
        });
      });

      it('sanitizes string values within objects', () => {
        const obj = {
          message: 'Connected to mongodb://user:password@host/db',
          jobId: 'job-123',
        };
        const result = sanitize(obj);
        expect(result).toEqual({
          message: `Connected to mongodb://user:${MASK}@host/db`,
          jobId: 'job-123',
        });
      });
    });

    describe('array sanitization', () => {
      it('sanitizes arrays of primitives', () => {
        // API key must be 32+ chars after sk-or-v1- prefix
        const arr = ['normal', 'sk-or-v1-secret123abc456def789abcdef123456', 'also normal'];
        const result = sanitize(arr);
        expect(result).toEqual(['normal', MASK, 'also normal']);
      });

      it('sanitizes arrays of objects', () => {
        const arr = [
          { id: '1', apiKey: 'secret1' },
          { id: '2', apiKey: 'secret2' },
        ];
        const result = sanitize(arr);
        expect(result).toEqual([
          { id: '1', apiKey: MASK },
          { id: '2', apiKey: MASK },
        ]);
      });

      it('sanitizes nested arrays', () => {
        const obj = {
          items: [{ password: 'pass1' }, { password: 'pass2' }],
        };
        const result = sanitize(obj);
        expect(result).toEqual({
          items: [{ password: MASK }, { password: MASK }],
        });
      });
    });

    describe('special types', () => {
      it('handles null', () => {
        expect(sanitize(null)).toBeNull();
      });

      it('handles undefined', () => {
        expect(sanitize(undefined)).toBeUndefined();
      });

      it('handles numbers', () => {
        expect(sanitize(42)).toBe(42);
      });

      it('handles booleans', () => {
        expect(sanitize(true)).toBe(true);
        expect(sanitize(false)).toBe(false);
      });

      it('handles Date objects', () => {
        const date = new Date('2024-01-01');
        expect(sanitize(date)).toEqual(date);
      });

      it('handles Error objects', () => {
        const error = new Error('Connection failed for mongodb://user:pass@host');
        const result = sanitize(error) as { name: string; message: string; stack?: string };
        expect(result.name).toBe('Error');
        expect(result.message).toBe(`Connection failed for mongodb://user:${MASK}@host`);
        expect(result.stack).toBeDefined();
      });
    });

    describe('complex real-world scenarios', () => {
      it('sanitizes a typical log context object', () => {
        const context = {
          jobId: 'job-abc-123',
          userId: 'user-def-456',
          projectId: 'proj-ghi-789',
          url: 'https://example.com',
          model: 'gpt-4',
          apiKey: 'sk-or-v1-secretkey123456789012345678901234',
          databaseUrl: 'mongodb://admin:password123@cluster.mongodb.net/db',
          headers: {
            authorization: 'Bearer eyJtoken...',
            cookie: 'session=abc123',
          },
        };

        const result = sanitize(context);

        expect(result).toEqual({
          jobId: 'job-abc-123',
          userId: 'user-def-456',
          projectId: 'proj-ghi-789',
          url: 'https://example.com',
          model: 'gpt-4',
          apiKey: MASK,
          databaseUrl: `mongodb://admin:${MASK}@cluster.mongodb.net/db`,
          headers: {
            authorization: MASK,
            cookie: MASK,
          },
        });
      });

      it('sanitizes scan job payload', () => {
        const payload = {
          id: 'scan-123',
          jobId: 'job-456',
          userId: 'user-789',
          projectId: 'proj-012',
          url: 'https://example.com',
          model: 'claude-3',
          encryptedHeaders: 'iv:ciphertext:tag',
          byokKey: 'sk-or-v1-userkey12345678901234567890',
        };

        const result = sanitize(payload);

        expect(result).toEqual({
          id: 'scan-123',
          jobId: 'job-456',
          userId: 'user-789',
          projectId: 'proj-012',
          url: 'https://example.com',
          model: 'claude-3',
          encryptedHeaders: MASK,
          byokKey: MASK,
        });
      });
    });
  });

  describe('sanitizeError', () => {
    it('sanitizes error message containing secrets', () => {
      // API key must be 32+ chars after sk-or-v1- prefix
      const error = new Error('Failed to connect with key sk-or-v1-secret12345678901234567890123456');
      const result = sanitizeError(error);

      expect(result.name).toBe('Error');
      expect(result.message).toBe(`Failed to connect with key ${MASK}`);
    });

    it('sanitizes error message containing connection string', () => {
      const error = new Error('MongoDB connection failed: mongodb://user:password@host/db');
      const result = sanitizeError(error);

      expect(result.message).toBe(`MongoDB connection failed: mongodb://user:${MASK}@host/db`);
    });

    it('preserves error name', () => {
      class CustomError extends Error {
        constructor(message: string) {
          super(message);
          this.name = 'CustomError';
        }
      }

      const error = new CustomError('Secret: sk-ant-api03-secret12345678901234');
      const result = sanitizeError(error);

      expect(result.name).toBe('CustomError');
      expect(result.message).toBe(`Secret: ${MASK}`);
    });

    it('sanitizes stack trace', () => {
      const error = new Error('API call failed');
      // Simulate a stack trace with sensitive info (key must be 32+ chars after prefix)
      error.stack = `Error: API call failed
    at callApi (file.ts:10) with key sk-or-v1-secret12345678901234567890123456
    at processJob (worker.ts:20)`;

      const result = sanitizeError(error);

      expect(result.stack).toContain(MASK);
      expect(result.stack).not.toContain('sk-or-v1');
    });
  });
});
