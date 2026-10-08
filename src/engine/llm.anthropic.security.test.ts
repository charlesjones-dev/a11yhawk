/**
 * Security regression tests for the Anthropic provider's connection guard. The SDK uses
 * fetch, so the engine hands it createGuardedFetch, a fetch over node:http(s) with the same
 * guarded agent the OpenRouter client gets. These run the real guarded fetch and the real
 * SDK; `http.request` is patched to serve canned replies, so nothing leaves the process.
 */
import { EventEmitter } from 'node:events';
import http from 'node:http';
import type { RequestOptions } from 'node:http';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Logger } from '../logger/index.js';
import { LLMService, LlmRequestError } from './llm.js';

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

const API_KEY = 'sk-ant-caller-key-123';
const VALID_JSON = '{"url":"x","issues":[],"statistics":{}}';

function generate(baseUrl: string) {
  return new LLMService({ provider: 'anthropic', baseUrl }).generateScan(
    'prompt',
    'system',
    'claude-opus-5-5',
    API_KEY,
    ['c2NyZWVuc2hvdA=='],
    silent,
  );
}

/** The SSE stream of a minimal successful Messages API response. */
function sseBody(): string {
  const events: Array<[string, unknown]> = [
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-5-5',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      },
    ],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: VALID_JSON } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    [
      'message_delta',
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { input_tokens: 12, output_tokens: 7 },
      },
    ],
    ['message_stop', { type: 'message_stop' }],
  ];
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

interface CannedReply {
  status: number;
  headers: Record<string, string>;
  body: string;
}

interface SentRequest {
  url: string;
  options: RequestOptions;
  body: string;
}

/** Replace http.request with an in-process responder; records each request it receives. */
function fakeHttp(reply: CannedReply): SentRequest[] {
  const sent: SentRequest[] = [];
  vi.spyOn(http, 'request').mockImplementation(((
    url: URL,
    options: RequestOptions,
    callback: (res: http.IncomingMessage) => void,
  ) => {
    const req = new EventEmitter() as EventEmitter & Record<string, unknown>;
    Object.assign(req, {
      setTimeout() {
        return req;
      },
      destroy() {},
      end(body?: Buffer) {
        sent.push({ url: url.toString(), options, body: body?.toString() ?? '' });
        const res = Readable.from([Buffer.from(reply.body)]) as Readable & Record<string, unknown>;
        Object.assign(res, { statusCode: reply.status, statusMessage: 'canned', headers: reply.headers });
        setImmediate(() => callback(res as unknown as http.IncomingMessage));
      },
    });
    return req;
  }) as unknown as typeof http.request);
  return sent;
}

/** Fail any socket a guarded agent tries to open; a refused target never gets that far. */
function spyOnSocketCreation() {
  return vi.spyOn(http.Agent.prototype, 'createConnection').mockImplementation((_options, callback) => {
    callback?.(new Error('connection attempted'), undefined as never);
    return undefined;
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Anthropic endpoint guard', () => {
  it('refuses to connect to a link-local endpoint', async () => {
    const createConnection = spyOnSocketCreation();

    const error = await generate('http://169.254.169.254/latest/meta-data/').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LlmRequestError);
    expect((error as LlmRequestError).code).toBe('llm-failed');
    expect(createConnection).not.toHaveBeenCalled();
  });

  it('never connects to a private host, so the API key is never sent there', async () => {
    const createConnection = spyOnSocketCreation();

    await expect(generate('http://10.0.0.5:8500/')).rejects.toThrow();

    expect(createConnection).not.toHaveBeenCalled();
  });
});

describe('guarded fetch', () => {
  it('streams a response through the guarded agent', async () => {
    const sent = fakeHttp({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: sseBody() });

    const result = await generate('http://llm-gateway.test/');

    expect(result.content).toBe(VALID_JSON);
    expect(result.usage).toMatchObject({ promptTokens: 12, completionTokens: 7 });
    expect(sent).toHaveLength(1);
    const [request] = sent;
    expect(request!.url).toMatch(/^http:\/\/llm-gateway\.test\/v1\/messages/);
    expect(request!.options.method).toBe('POST');
    expect(request!.options.agent).toBeInstanceOf(http.Agent);
    const headers = request!.options.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe(API_KEY);
    expect(headers['accept-encoding']).toBe('identity');
    expect(headers['content-length']).toBe(String(Buffer.byteLength(request!.body)));
    expect(JSON.parse(request!.body)).toMatchObject({ model: 'claude-opus-5-5', stream: true });
  });

  it('does not follow a redirect', async () => {
    const sent = fakeHttp({
      status: 307,
      headers: { location: 'http://169.254.169.254/', 'x-should-retry': 'false' },
      body: '',
    });

    const error = await generate('http://llm-gateway.test/').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LlmRequestError);
    expect((error as LlmRequestError).message).toBe('LLM request failed with HTTP 307.');
    expect(sent).toHaveLength(1);
  });

  it('passes an error status through for the SDK to classify', async () => {
    fakeHttp({
      status: 401,
      headers: { 'content-type': 'application/json', 'x-should-retry': 'false' },
      body: JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'bad key' } }),
    });

    const error = await generate('http://llm-gateway.test/').catch((e: unknown) => e);

    expect((error as LlmRequestError).code).toBe('llm-auth');
  });
});
