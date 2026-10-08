/**
 * Anthropic provider tests. The SDK client gets a mock fetch in place of the guarded one
 * (createGuardedFetch is the only fetch the engine hands it in the default posture), so every
 * request goes through the real SDK: request building, SSE parsing, retries, and typed
 * errors. DNS and the browser stage are mocked; nothing here opens a socket.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const state = vi.hoisted(() => ({
  fetch: null as null | FetchFn,
  guardProtocols: [] as string[],
  tiles: ['AAAA'] as string[],
  analyzeCalls: [] as Array<{ model: string; llmProvider: unknown }>,
}));

vi.mock('dns/promises', () => ({
  resolve4: async () => ['93.184.216.34'],
  resolve6: async () => {
    throw Object.assign(new Error('ENODATA'), { code: 'ENODATA' });
  },
  lookup: async () => [{ address: '93.184.216.34', family: 4 }],
}));

vi.mock('./request-guard.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./request-guard.js')>();
  return {
    ...actual,
    createGuardedFetch: (protocol: string): FetchFn => {
      state.guardProtocols.push(protocol);
      return (input, init) => {
        if (!state.fetch) throw new Error('no fetch reply configured');
        return state.fetch(input, init);
      };
    },
  };
});

vi.mock('./playwright.js', () => ({
  PlaywrightService: class {
    setConcurrency() {}
    async acquireBrowser() {}
    async releaseBrowser() {}
    async cleanup() {}
    getCDPPort() {
      return null;
    }
    async analyzePage(_url: string, model: string, ...rest: unknown[]) {
      const options = rest[4] as { llmProvider?: unknown } | undefined;
      state.analyzeCalls.push({ model, llmProvider: options?.llmProvider });
      return {
        title: 'Page',
        screenshotBuffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
        screenshotTiles: [...state.tiles],
        accessibilityTree: { role: 'WebArea', children: [] },
        html: '<html><body><p>page</p></body></html>',
        finalUrl: 'https://scan-target.test/',
      };
    }
  },
}));

import type { Logger } from '../logger/index.js';
import type { ModelPricing } from '../types.js';
import { LLMService, LlmRequestError, type GenerationParams } from './llm.js';
import { A11yHawkEngine, ScanError } from './scan.js';

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
const CANARY = 'CANARY-PROVIDER-BODY-5521';
const VALID_JSON = '{"url":"x","issues":[],"statistics":{}}';
const PARAMS: GenerationParams = { temperature: 0.7, topP: 0.5, frequencyPenalty: 1, maxTokens: 1000 };

interface CapturedRequest {
  url: URL;
  headers: Headers;
  body: Record<string, unknown>;
}

const requests: CapturedRequest[] = [];

/** Answer every request with a fresh response from `reply`, recording what was sent. */
function replyWith(reply: () => Response | Promise<Response>): void {
  state.fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push({ url: new URL(request.url), headers: request.headers, body: JSON.parse(await request.text()) });
    return reply();
  };
}

interface FakeMessage {
  model?: string;
  content?: Array<Record<string, unknown>>;
  stopReason?: string;
  stopDetails?: Record<string, unknown> | null;
  usage?: Record<string, unknown>;
}

/** A streamed Messages API response, one complete block per content_block_start. */
function sse(message: FakeMessage = {}): Response {
  const events: Array<[string, unknown]> = [
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: message.model ?? 'claude-opus-5-5',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          stop_details: null,
          usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      },
    ],
  ];
  (message.content ?? [{ type: 'text', text: VALID_JSON }]).forEach((block, index) => {
    events.push(['content_block_start', { type: 'content_block_start', index, content_block: block }]);
    events.push(['content_block_stop', { type: 'content_block_stop', index }]);
  });
  events.push([
    'message_delta',
    {
      type: 'message_delta',
      delta: {
        stop_reason: message.stopReason ?? 'end_turn',
        stop_sequence: null,
        stop_details: message.stopDetails ?? null,
      },
      usage: message.usage ?? {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  ]);
  events.push(['message_stop', { type: 'message_stop' }]);
  const body = events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** A non-2xx API error. x-should-retry: false makes the SDK answer at once instead of retrying. */
function apiError(status: number, type: string, details?: Record<string, unknown>): Response {
  const body = { type: 'error', error: { type, message: `${CANARY} ${API_KEY}`, ...(details ? { details } : {}) } };
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-should-retry': 'false' },
  });
}

function anthropicService(
  config: { pricing?: Record<string, ModelPricing>; refusalFallback?: boolean; baseUrl?: string } = {},
) {
  return new LLMService({ provider: 'anthropic', ...config });
}

function generate(service: LLMService, options: { model?: string; tiles?: string[]; params?: GenerationParams } = {}) {
  return service.generateScan(
    'PROMPT',
    'SYSTEM',
    options.model ?? 'claude-opus-5-5',
    API_KEY,
    options.tiles ?? ['VElMRTE=', 'VElMRTI='],
    silent,
    options.params ?? PARAMS,
  );
}

async function generateError(service: LLMService, options?: Parameters<typeof generate>[1]): Promise<LlmRequestError> {
  const error = await generate(service, options).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(LlmRequestError);
  return error as LlmRequestError;
}

beforeEach(() => {
  requests.length = 0;
  state.guardProtocols.length = 0;
  state.analyzeCalls.length = 0;
  state.tiles = ['AAAA'];
  replyWith(() => sse());
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('Anthropic request', () => {
  it('sends a cached system block, the prompt, then one image block per tile, and no sampling parameters', async () => {
    await generate(anthropicService());

    expect(requests).toHaveLength(1);
    const { body } = requests[0]!;
    expect(body.model).toBe('claude-opus-5-5');
    expect(body.max_tokens).toBe(1000);
    expect(body.stream).toBe(true);
    expect(body.system).toEqual([{ type: 'text', text: 'SYSTEM', cache_control: { type: 'ephemeral' } }]);
    expect(body.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'PROMPT' },
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'VElMRTE=' } },
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'VElMRTI=' } },
        ],
      },
    ]);
    for (const key of ['temperature', 'top_p', 'top_k', 'frequency_penalty', 'thinking']) {
      expect(body).not.toHaveProperty(key);
    }
  });

  it('sends output_config.effort only when effort is set', async () => {
    await generate(anthropicService());
    await generate(anthropicService(), { params: { ...PARAMS, effort: 'xhigh' } });

    expect(requests[0]!.body).not.toHaveProperty('output_config');
    expect(requests[1]!.body.output_config).toEqual({ effort: 'xhigh' });
  });

  it('opts into the server-side refusal fallback only for models that support it', async () => {
    await generate(anthropicService(), { model: 'claude-opus-5-5' });
    await generate(anthropicService(), { model: 'claude-haiku-5-5' });
    await generate(anthropicService({ refusalFallback: false }), { model: 'claude-opus-5-5' });

    const [opus, haiku, optedOut] = requests;
    expect(opus!.body.fallbacks).toBe('default');
    expect(opus!.headers.get('anthropic-beta')).toBe('server-side-fallback-2026-07-01');
    for (const request of [haiku!, optedOut!]) {
      expect(request.body).not.toHaveProperty('fallbacks');
      expect(request.headers.get('anthropic-beta')).toBeNull();
    }
  });

  it('calls the Claude API by default and the configured base URL otherwise, through the guarded fetch', async () => {
    await generate(anthropicService());
    await generate(anthropicService({ baseUrl: 'https://llm-gateway.test/anthropic' }));

    expect(`${requests[0]!.url.origin}${requests[0]!.url.pathname}`).toBe('https://api.anthropic.com/v1/messages');
    expect(`${requests[1]!.url.origin}${requests[1]!.url.pathname}`).toBe(
      'https://llm-gateway.test/anthropic/v1/messages',
    );
    expect(state.guardProtocols).toEqual(['https:', 'https:']);
    expect(requests[0]!.headers.get('x-api-key')).toBe(API_KEY);
  });

  it('ignores ANTHROPIC_* environment variables', async () => {
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://env-endpoint.test');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-env-key');
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'env-bearer-token');
    vi.stubEnv('ANTHROPIC_CUSTOM_HEADERS', 'x-api-key: sk-ant-env-key\nx-env-header: leaked');
    vi.stubEnv('ANTHROPIC_PROFILE', 'profile-that-does-not-exist');
    vi.stubEnv('ANTHROPIC_LOG', 'debug');
    const consoleSpies = (['debug', 'info', 'warn', 'error', 'log'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => {}),
    );

    await generate(anthropicService());

    const { url, headers } = requests[0]!;
    expect(url.origin).toBe('https://api.anthropic.com');
    expect(headers.get('x-api-key')).toBe(API_KEY);
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('x-env-header')).toBeNull();
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  });
});

describe('Anthropic response', () => {
  it('builds the text from text blocks only', async () => {
    replyWith(() =>
      sse({
        content: [
          { type: 'thinking', thinking: 'SECRET-REASONING', signature: 'sig' },
          { type: 'text', text: '{"url":"x",' },
          { type: 'text', text: '"issues":[],"statistics":{}}' },
        ],
      }),
    );

    const result = await generate(anthropicService());

    expect(result.content).toBe(VALID_JSON);
  });

  it('fails a refusal as non-retryable llm-refused naming the category', async () => {
    replyWith(() =>
      sse({
        content: [{ type: 'text', text: 'partial' }],
        stopReason: 'refusal',
        stopDetails: { type: 'refusal', category: 'cyber', explanation: CANARY },
      }),
    );

    const error = await generateError(anthropicService());

    expect(error.code).toBe('llm-refused');
    expect(error.retryable).toBe(false);
    expect(error.message).toBe('The model declined to analyze this page (refusal category: cyber).');
  });

  it('leaves the category out of a refusal without one', async () => {
    replyWith(() => sse({ content: [], stopReason: 'refusal', stopDetails: { type: 'refusal', category: null } }));

    const error = await generateError(anthropicService());

    expect(error.code).toBe('llm-refused');
    expect(error.message).toBe('The model declined to analyze this page.');
  });

  it('fails a response cut off at max_tokens as llm-malformed', async () => {
    replyWith(() => sse({ content: [{ type: 'text', text: '{"url":"x","iss' }], stopReason: 'max_tokens' }));

    const error = await generateError(anthropicService());

    expect(error.code).toBe('llm-malformed');
    expect(error.retryable).toBe(false);
    expect(error.message).toContain('cut off');
  });

  it('refuses more tiles than one request accepts, before calling the API', async () => {
    const error = await generateError(anthropicService(), { tiles: Array.from({ length: 101 }, () => 'AAAA') });

    expect(error.code).toBe('llm-failed');
    expect(error.retryable).toBe(false);
    expect(error.message).toContain('101 image tiles');
    expect(requests).toHaveLength(0);
  });
});

describe('Anthropic usage and cost', () => {
  const usage = {
    input_tokens: 1000,
    output_tokens: 500,
    cache_read_input_tokens: 2000,
    cache_creation_input_tokens: 4000,
    output_tokens_details: { thinking_tokens: 300 },
  };

  it('counts cache reads and writes as prompt tokens and prices them at the default cache rates', async () => {
    replyWith(() => sse({ usage }));

    const result = await generate(
      anthropicService({ pricing: { 'claude-opus-5-5': { inputPer1M: 4, outputPer1M: 20 } } }),
    );

    expect(result.usage).toEqual({
      promptTokens: 7000,
      completionTokens: 500,
      totalTokens: 7500,
      // 1000 x $4 + 500 x $20 + 2000 x $0.40 + 4000 x $5, per million
      cost: expect.closeTo(0.0348, 10),
      modelId: 'claude-opus-5-5',
      cachedTokens: 2000,
      cacheWriteTokens: 4000,
      reasoningTokens: 300,
      servedModelId: 'claude-opus-5-5',
    });
  });

  it('uses explicit cache prices when given', async () => {
    replyWith(() => sse({ usage }));

    const result = await generate(
      anthropicService({
        pricing: { 'claude-opus-5-5': { inputPer1M: 4, outputPer1M: 20, cacheReadPer1M: 0.2, cacheWritePer1M: 6 } },
      }),
    );

    expect(result.usage?.cost).toBeCloseTo(0.0384, 10);
  });

  it('reports cost 0 when the model that answered has no pricing entry', async () => {
    replyWith(() => sse({ usage }));

    const result = await generate(
      anthropicService({ pricing: { 'claude-sonnet-5-5': { inputPer1M: 2, outputPer1M: 10 } } }),
    );

    expect(result.usage?.cost).toBe(0);
    expect(result.usage?.promptTokens).toBe(7000);
  });

  it('prices each attempt at its own model after a fallback and reports the model that answered', async () => {
    replyWith(() =>
      sse({
        model: 'claude-opus-5-5',
        content: [
          {
            type: 'fallback',
            from: { model: 'claude-opus-5-5' },
            to: { model: 'claude-opus-5' },
            trigger: { type: 'refusal', category: 'cyber' },
          },
          { type: 'text', text: VALID_JSON },
        ],
        usage: {
          input_tokens: 400,
          output_tokens: 200,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 0,
          iterations: [
            {
              type: 'message',
              model: 'claude-opus-5-5',
              input_tokens: 500,
              output_tokens: 0,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 1000,
            },
            {
              type: 'fallback_message',
              model: 'claude-opus-5',
              input_tokens: 400,
              output_tokens: 200,
              cache_read_input_tokens: 100,
              cache_creation_input_tokens: 0,
            },
          ],
        },
      }),
    );

    const result = await generate(
      anthropicService({
        pricing: {
          'claude-opus-5-5': { inputPer1M: 4, outputPer1M: 20 },
          'claude-opus-5': { inputPer1M: 5, outputPer1M: 25 },
        },
      }),
    );

    expect(result.content).toBe(VALID_JSON);
    expect(result.usage).toMatchObject({
      promptTokens: 2000,
      completionTokens: 200,
      totalTokens: 2200,
      cachedTokens: 100,
      cacheWriteTokens: 1000,
      modelId: 'claude-opus-5-5',
      servedModelId: 'claude-opus-5',
    });
    // Opus 5.5: 500 x $4 + 1000 x $5 (write). Opus 5: 400 x $5 + 200 x $25 + 100 x $0.50.
    expect(result.usage?.cost).toBeCloseTo(0.01405, 10);
  });

  it('reports cost 0 when a fallback model that ran has no pricing entry', async () => {
    replyWith(() =>
      sse({
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          iterations: [
            { type: 'message', model: 'claude-opus-5-5', input_tokens: 10, output_tokens: 0 },
            { type: 'fallback_message', model: 'claude-opus-4-8', input_tokens: 10, output_tokens: 5 },
          ],
        },
      }),
    );

    const result = await generate(
      anthropicService({ pricing: { 'claude-opus-5-5': { inputPer1M: 4, outputPer1M: 20 } } }),
    );

    expect(result.usage?.cost).toBe(0);
  });
});

describe('Anthropic failures through the engine', () => {
  async function scanError(): Promise<ScanError> {
    const engine = new A11yHawkEngine({ logger: silent });
    const error = await engine
      .scan('https://scan-target.test/', {
        lighthouse: false,
        annotate: false,
        llm: { apiKey: API_KEY, provider: 'anthropic' },
        logger: silent,
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ScanError);
    const scanErr = error as ScanError;
    expect(scanErr.message).not.toContain(CANARY);
    expect(scanErr.message).not.toContain(API_KEY);
    return scanErr;
  }

  const rows: Array<{ name: string; reply: () => Response; code: string; retryable: boolean; message?: string }> = [
    {
      name: '401',
      reply: () => apiError(401, 'authentication_error'),
      code: 'llm-auth',
      retryable: false,
      message: 'API key is invalid or expired. Please check your Anthropic API key.',
    },
    { name: '403', reply: () => apiError(403, 'permission_error'), code: 'llm-auth', retryable: false },
    { name: '402 billing_error', reply: () => apiError(402, 'billing_error'), code: 'llm-billing', retryable: false },
    {
      name: '429 spend cap',
      reply: () => apiError(429, 'rate_limit_error', { error_code: 'enforced_spend_limit_reached' }),
      code: 'llm-billing',
      retryable: false,
    },
    {
      name: '404',
      reply: () => apiError(404, 'not_found_error'),
      code: 'llm-failed',
      retryable: false,
      message:
        'LLM analysis failed: Model "claude-opus-5-5" was not found or is not available to this API key (HTTP 404).',
    },
    {
      name: '400',
      reply: () => apiError(400, 'invalid_request_error'),
      code: 'llm-failed',
      retryable: false,
      message: 'LLM analysis failed: LLM request failed with HTTP 400.',
    },
    { name: '413', reply: () => apiError(413, 'request_too_large'), code: 'llm-failed', retryable: false },
    {
      name: '429',
      reply: () => apiError(429, 'rate_limit_error'),
      code: 'llm-rate-limit',
      retryable: true,
      message: 'Rate limited. Try again shortly.',
    },
    { name: '529', reply: () => apiError(529, 'overloaded_error'), code: 'llm-failed', retryable: true },
    {
      name: '500',
      reply: () => apiError(500, 'api_error'),
      code: 'llm-failed',
      retryable: true,
      message: 'LLM analysis failed: LLM request failed with HTTP 500.',
    },
    {
      name: 'an error event mid-stream',
      reply: () =>
        new Response(
          `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: CANARY } })}\n\n`,
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ),
      code: 'llm-failed',
      retryable: true,
    },
    {
      name: 'a refusal',
      reply: () => sse({ content: [], stopReason: 'refusal', stopDetails: { type: 'refusal', category: 'bio' } }),
      code: 'llm-refused',
      retryable: false,
      message: 'The model declined to analyze this page (refusal category: bio).',
    },
    {
      name: 'max_tokens',
      reply: () => sse({ content: [{ type: 'text', text: '{' }], stopReason: 'max_tokens' }),
      code: 'llm-malformed',
      retryable: false,
    },
  ];

  for (const row of rows) {
    it(`maps ${row.name} to ${row.retryable ? 'retryable' : 'non-retryable'} ${row.code}`, async () => {
      replyWith(row.reply);

      const error = await scanError();

      expect(error.code).toBe(row.code);
      expect(error.retryable).toBe(row.retryable);
      if (row.message) expect(error.message).toBe(row.message);
    });
  }

  it('maps a connection failure to retryable llm-failed after the SDK retries', async () => {
    let calls = 0;
    state.fetch = async () => {
      calls += 1;
      throw new TypeError('fetch failed');
    };

    const error = await scanError();

    expect(error.code).toBe('llm-failed');
    expect(error.retryable).toBe(true);
    expect(calls).toBe(3);
  });

  it('maps a timeout to retryable llm-failed', async () => {
    vi.useFakeTimers();
    state.fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });

    const pending = generate(anthropicService()).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    const error = await pending;

    expect(error).toBeInstanceOf(LlmRequestError);
    expect((error as LlmRequestError).code).toBe('llm-failed');
    expect((error as LlmRequestError).retryable).toBe(true);
    expect((error as LlmRequestError).message).toBe('LLM request timed out.');
  });

  it('fails a page with more tiles than one request accepts as non-retryable, without calling the API', async () => {
    state.tiles = Array.from({ length: 101 }, () => 'AAAA');

    const error = await scanError();

    expect(error.code).toBe('llm-failed');
    expect(error.retryable).toBe(false);
    expect(requests).toHaveLength(0);
  });
});

describe('Anthropic scans through the engine', () => {
  it('uses the Anthropic default model, sizes tiles for Anthropic, and reports provider usage', async () => {
    replyWith(() =>
      sse({
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 20, cache_creation_input_tokens: 30 },
      }),
    );
    const engine = new A11yHawkEngine({ logger: silent });

    const report = await engine.scan('https://scan-target.test/', {
      lighthouse: false,
      annotate: false,
      llm: {
        apiKey: API_KEY,
        provider: 'anthropic',
        pricing: { 'claude-opus-5-5': { inputPer1M: 4, outputPer1M: 20 } },
      },
      logger: silent,
    });

    expect(state.analyzeCalls).toEqual([{ model: 'claude-opus-5-5', llmProvider: 'anthropic' }]);
    expect(requests[0]!.body.model).toBe('claude-opus-5-5');
    expect(report.usage).toMatchObject({
      provider: 'anthropic',
      modelId: 'claude-opus-5-5',
      servedModelId: 'claude-opus-5-5',
      promptTokens: 60,
      cachedTokens: 20,
      cacheWriteTokens: 30,
      costType: 'user',
    });
    expect(report.usage?.cost).toBeGreaterThan(0);
  });

  it('rejects an unknown provider or effort before any browser work', async () => {
    const engine = new A11yHawkEngine({ logger: silent });
    const scanWith = (llm: Record<string, unknown>) =>
      engine
        .scan('https://scan-target.test/', { lighthouse: false, llm: { apiKey: API_KEY, ...llm }, logger: silent })
        .then(
          () => null,
          (e: unknown) => e as ScanError,
        );

    const provider = await scanWith({ provider: 'gemini' });
    const effort = await scanWith({ provider: 'anthropic', generationParams: { effort: 'extreme' } });
    const pricing = await scanWith({ provider: 'anthropic', pricing: { 'claude-opus-5-5': { inputPer1M: 4 } } });

    for (const error of [provider, effort, pricing]) {
      expect(error).toBeInstanceOf(ScanError);
      expect(error?.code).toBe('invalid-options');
      expect(error?.retryable).toBe(false);
    }
    expect(state.analyzeCalls).toHaveLength(0);
  });
});
