/**
 * Security regression tests for LLMService: the endpoint must stay public on every
 * connection unless private networks are allowed, non-2xx response bodies must not come
 * back in the thrown error, and provider usage counters must be numbers.
 *
 * The OpenAI SDK (v4) uses node-fetch in Node, which calls `http.request` at call time,
 * so patching `http.request` serves canned replies through the real SDK request path.
 * Nothing here opens a socket to another host.
 */
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Logger } from '../logger/index.js';
import { LLMService } from './llm.js';

const silent: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silent;
  },
  async flush() {},
};

interface CannedReply {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** Replace http.request with an in-process responder; returns the number of requests made. */
function fakeHttp(reply: CannedReply): { count: number } {
  const calls = { count: 0 };
  vi.spyOn(http, 'request').mockImplementation((() => {
    calls.count += 1;
    const req = new EventEmitter() as EventEmitter & Record<string, unknown>;
    const respond = () => {
      const res = Readable.from([Buffer.from(reply.body)]) as Readable & {
        statusCode: number;
        statusMessage: string;
        headers: Record<string, string>;
      };
      res.statusCode = reply.status;
      res.statusMessage = 'canned';
      res.headers = reply.headers;
      setImmediate(() => req.emit('response', res));
    };
    Object.assign(req, {
      write() {
        return true;
      },
      end() {
        respond();
      },
      abort() {},
      destroy() {},
      setTimeout() {
        return req;
      },
      setHeader() {},
      getHeader() {
        return undefined;
      },
      flushHeaders() {},
      setNoDelay() {},
      setSocketKeepAlive() {},
    });
    return req;
  }) as unknown as typeof http.request);
  return calls;
}

/**
 * Spy on the socket factory behind every guarded HTTP connection. A guarded agent that
 * refuses the target never reaches it; if one ever does, the spy fails the connection
 * instead of letting it out.
 */
function spyOnSocketCreation() {
  return vi.spyOn(http.Agent.prototype, 'createConnection').mockImplementation((_options, callback) => {
    callback?.(new Error('connection attempted'), undefined as never);
    return undefined;
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

const CANARY_BODY = 'CANARY-INTERNAL-RESPONSE-BODY-7731';

describe('LLMService endpoint guard', () => {
  it('refuses to connect to a link-local endpoint', async () => {
    const createConnection = spyOnSocketCreation();
    const service = new LLMService({ baseUrl: 'http://169.254.169.254/latest/meta-data/?' });

    await expect(
      service.generateScan('prompt', 'system', 'any/model', 'client-token', ['c2NyZWVuc2hvdA=='], silent),
    ).rejects.toThrow();

    expect(createConnection).not.toHaveBeenCalled();
  });

  it('never connects to a private host, so a caller-chosen bearer token is never sent there', async () => {
    const createConnection = spyOnSocketCreation();
    const service = new LLMService({ baseUrl: 'http://10.0.0.5:8500/v1/agent/self?' });

    await expect(
      service.generateScan('prompt', 'system', 'any/model', 'client-token', undefined, silent),
    ).rejects.toThrow();

    expect(createConnection).not.toHaveBeenCalled();
  });
});

describe('LLMService error messages', () => {
  // allowPrivateNetworks lets the request reach the canned reply; the body must stay out
  // of the message even then.
  it('reports only the status for a non-2xx JSON reply', async () => {
    fakeHttp({
      status: 403,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: { type: 'security_exception', reason: CANARY_BODY } }),
    });
    const service = new LLMService({ baseUrl: 'http://10.0.0.5/internal/', allowPrivateNetworks: true });

    const error = await service
      .generateScan('prompt', 'system', 'any/model', 'client-token', undefined, silent)
      .catch((e: Error) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('LLM request failed with HTTP 403.');
  });

  it('reports only the status for a non-2xx plain-text reply', async () => {
    fakeHttp({ status: 405, headers: { 'content-type': 'text/plain' }, body: `method not allowed ${CANARY_BODY}` });
    const service = new LLMService({
      baseUrl: 'http://192.168.1.10:9200/_cluster/health?',
      allowPrivateNetworks: true,
    });

    const error = await service
      .generateScan('prompt', 'system', 'any/model', 'client-token', undefined, silent)
      .catch((e: Error) => e);

    expect((error as Error).message).not.toContain(CANARY_BODY);
    expect((error as Error).message).toContain('HTTP 405');
  });

  it('keeps the dedicated 401 message', async () => {
    fakeHttp({ status: 401, headers: { 'content-type': 'application/json' }, body: '{"error":"bad key"}' });
    const service = new LLMService({ allowPrivateNetworks: true });

    await expect(service.generateScan('prompt', 'system', 'any/model', 'k', undefined, silent)).rejects.toThrow(
      'API key is invalid or expired',
    );
  });
});

describe('LLMService usage counters', () => {
  it('drops non-numeric counters instead of passing strings through', async () => {
    const PAYLOAD = '<img src=x onerror="alert(1)">';
    fakeHttp({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        choices: [{ message: { content: '{"url":"x","issues":[],"statistics":{}}' } }],
        usage: {
          prompt_tokens: PAYLOAD,
          completion_tokens: 2,
          total_tokens: 3,
          cost: '1',
          prompt_tokens_details: { cached_tokens: PAYLOAD },
        },
      }),
    });
    const service = new LLMService({ baseUrl: 'http://10.0.0.5/', allowPrivateNetworks: true });

    const result = await service.generateScan('prompt', 'system', 'any/model', 'client-token', undefined, silent);

    expect(result.usage).toMatchObject({ promptTokens: 0, completionTokens: 2, totalTokens: 3, cost: 0 });
    expect(result.usage?.cachedTokens).toBeUndefined();
  });
});
