import Anthropic from '@anthropic-ai/sdk';
import type { ClientOptions } from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type {
  ChatCompletionMessageParam,
  ChatCompletionContentPart,
  ChatCompletionCreateParamsNonStreaming,
} from 'openai/resources/chat/completions';
import type { Logger } from '../logger/index.js';
import { createLogger } from '../logger/index.js';
import type { LlmEffort, LlmProvider, ModelPricing } from '../types.js';
import { createGuardedAgent, createGuardedFetch } from './request-guard.js';
import type { ScanErrorCode } from './scan.js';

const defaultLogger = createLogger();

/**
 * OpenRouter-specific request parameters that extend the standard OpenAI SDK
 */
interface OpenRouterChatCompletionParams extends ChatCompletionCreateParamsNonStreaming {
  usage?: { include: boolean };
}

/**
 * OpenRouter-specific usage response that extends the standard OpenAI usage object
 */
interface OpenRouterUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cost?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
  completion_tokens_details?: {
    reasoning_tokens?: number;
  };
}

/**
 * LLM generation parameters (configurable via admin settings)
 */
export interface GenerationParams {
  temperature: number;
  topP: number;
  frequencyPenalty: number;
  maxTokens: number;
  /** Anthropic only. */
  effort?: LlmEffort;
}

/**
 * Default generation parameters (used when not provided)
 */
const DEFAULT_GENERATION_PARAMS: GenerationParams = {
  temperature: 0.2,
  topP: 0.95,
  frequencyPenalty: 0,
  maxTokens: 64000,
};

/**
 * Result of a scan generation including content and usage data
 */
export interface ScanResult {
  content: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cost: number;
    modelId: string;
    cachedTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
    servedModelId?: string;
  } | null;
}

/**
 * Sanitize error messages to remove any potential sensitive data
 */
function sanitizeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // Remove potential API keys or tokens from error messages
  return message.replace(/sk-[a-zA-Z0-9-_]+/g, '[REDACTED]');
}

/** ScanError codes a provider can assign to its own failures. */
export type LlmErrorCode = Extract<ScanErrorCode, `llm-${string}`>;

/**
 * A failed LLM request. `status` is the endpoint's HTTP status when it answered, so callers
 * classify failures by status rather than by message text. A provider that classifies its
 * own failures (Anthropic) also sets `code` and `retryable`; OpenRouter failures leave
 * `code` unset and are classified by `status`.
 */
export class LlmRequestError extends Error {
  readonly status: number | undefined;
  readonly code: LlmErrorCode | undefined;
  readonly retryable: boolean;

  // Takes no `cause`: the provider error can embed the API key (see generateScan).
  constructor(message: string, status?: number, classification?: { code: LlmErrorCode; retryable: boolean }) {
    super(message);
    this.name = 'LlmRequestError';
    this.status = status;
    this.code = classification?.code;
    this.retryable = classification?.retryable ?? false;
  }
}

/** Provider usage counters are untrusted input: keep finite numbers, drop anything else. */
function usageCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Configuration for the LLM service (previously sourced from environment variables)
 */
export interface LLMServiceConfig {
  /** Default 'openrouter'. */
  provider?: LlmProvider;
  baseUrl?: string;
  /** OpenRouter only. */
  httpReferer?: string;
  /** OpenRouter only. */
  appTitle?: string;
  debug?: boolean;
  /**
   * Permit connections to private, loopback, and link-local endpoints. Default false:
   * every connection (redirect hops included) must reach a public address.
   */
  allowPrivateNetworks?: boolean;
  /** Anthropic only: USD per million tokens by model id, for estimating cost. */
  pricing?: Record<string, ModelPricing>;
  /** Anthropic only: use the server-side refusal fallback where the model supports it. Default true. */
  refusalFallback?: boolean;
}

/** One LLM call as a provider sees it. */
interface GenerateRequest {
  prompt: string;
  systemPrompt: string;
  model: string;
  apiKey: string;
  tiles: string[];
  params: GenerationParams;
  log: Logger;
}

/**
 * A provider's client. Failures throw with messages that are safe to show the caller: no
 * API key and no response body.
 */
interface LlmProviderClient {
  generate(request: GenerateRequest): Promise<ScanResult>;
}

// --- OpenRouter (any OpenAI-compatible endpoint) -------------------------------

class OpenRouterProvider implements LlmProviderClient {
  private readonly baseUrl: string;
  private readonly httpReferer: string;
  private readonly appTitle: string;
  private readonly allowPrivateNetworks: boolean;

  constructor(config: LLMServiceConfig) {
    this.baseUrl = config.baseUrl ?? 'https://openrouter.ai/api/v1';
    this.httpReferer = config.httpReferer ?? 'https://github.com/charlesjones-dev/a11yhawk';
    this.appTitle = config.appTitle ?? 'A11yHawk';
    this.allowPrivateNetworks = config.allowPrivateNetworks ?? false;
  }

  /**
   * Creates an OpenAI client configured for OpenRouter
   * @param apiKey The OpenRouter API key (provided by client)
   */
  private createClient(apiKey: string): OpenAI {
    return new OpenAI({
      baseURL: this.baseUrl,
      apiKey: apiKey,
      defaultHeaders: {
        'HTTP-Referer': this.httpReferer,
        'X-Title': this.appTitle,
      },
      // The endpoint receives the API key and the scan data, so unless private networks
      // are allowed it must stay public on every connection, not just at validation time.
      ...(this.allowPrivateNetworks ? {} : { httpAgent: createGuardedAgent(new URL(this.baseUrl).protocol) }),
    });
  }

  async generate({ prompt, systemPrompt, model, apiKey, tiles, params, log }: GenerateRequest): Promise<ScanResult> {
    // Build user content parts
    const userContent: ChatCompletionContentPart[] = [{ type: 'text', text: prompt }];

    // Add images if provided (may be multiple tiles for long pages)
    for (const tile of tiles) {
      userContent.push({
        type: 'image_url',
        image_url: {
          url: `data:image/jpeg;base64,${tile}`,
          // Note: 'detail' parameter is OpenAI-specific, omit for cross-provider compatibility
        },
      });
    }

    const messages: ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ];

    const startTime = Date.now();

    try {
      const client = this.createClient(apiKey);

      // OpenRouter supports a 'usage' parameter to include token/cost data in the response.
      // Since this is not in the OpenAI SDK types, we need to cast to bypass type checking.
      const completion = await client.chat.completions.create({
        model: model,
        messages: messages,
        temperature: params.temperature,
        max_tokens: params.maxTokens,
        top_p: params.topP,
        frequency_penalty: params.frequencyPenalty,
        usage: { include: true }, // OpenRouter-specific parameter
      } as OpenRouterChatCompletionParams);

      // Defensive check for malformed OpenRouter responses
      if (!completion || !completion.choices || completion.choices.length === 0) {
        log.error('Malformed response from OpenRouter', { model, hasChoices: false });
        throw new Error(
          'Model returned an empty response. The model may be overloaded - please try again or select a different model.',
        );
      }

      const content = completion.choices[0]?.message?.content || 'No response generated.';

      // Extract usage data if available
      let usage: ScanResult['usage'] = null;
      if (completion.usage) {
        const usageData = completion.usage as OpenRouterUsage; // OpenRouter extends standard usage object

        usage = {
          promptTokens: usageCount(usageData.prompt_tokens) ?? 0,
          completionTokens: usageCount(usageData.completion_tokens) ?? 0,
          totalTokens: usageCount(usageData.total_tokens) ?? 0,
          cost: usageCount(usageData.cost) ?? 0,
          modelId: model,
          cachedTokens: usageCount(usageData.prompt_tokens_details?.cached_tokens),
          reasoningTokens: usageCount(usageData.completion_tokens_details?.reasoning_tokens),
        };
      }

      return { content, usage };
    } catch (error: unknown) {
      const duration = Date.now() - startTime;
      // Log full error server-side for debugging (never logs API key)
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStatus = (error as { status?: number })?.status;
      // Capture OpenAI SDK error details (includes OpenRouter error response)
      const errorResponse = (
        error as { error?: { message?: string; type?: string; code?: string; metadata?: { raw?: string } } }
      )?.error;
      // Parse provider-specific error from metadata.raw if available
      let providerError: string | undefined;
      if (errorResponse?.metadata?.raw) {
        try {
          const rawError = JSON.parse(errorResponse.metadata.raw);
          providerError = rawError?.error?.message;
        } catch {
          // Ignore JSON parse errors
        }
      }
      const cause = (error as { cause?: unknown })?.cause;
      log.error('LLM API error', {
        durationMs: duration,
        model,
        status: errorStatus,
        errorName: error instanceof Error ? error.name : 'Unknown',
        providerError: providerError || errorResponse?.message || errorMessage,
        // Connection failures (including a guarded-agent refusal) carry the reason here.
        ...(cause instanceof Error ? { cause: sanitizeErrorMessage(cause) } : {}),
      });

      // The raw provider error is intentionally NOT chained as `cause` on any
      // throw below: it can embed the API key (in request dumps or auth
      // headers), and these sanitized errors exist to keep the key out of
      // anything a host might log.

      // Handle malformed response errors (common with OpenRouter)
      if (errorMessage.includes('Cannot read properties of undefined') || errorMessage.includes("reading '0'")) {
        // eslint-disable-next-line preserve-caught-error
        throw new Error(
          'Model returned an invalid response. The model may be unavailable - please try a different model.',
        );
      }

      // Provide specific error for API key issues (401 Unauthorized)
      if (errorStatus === 401) {
        throw new LlmRequestError('API key is invalid or expired. Please check your OpenRouter API key.', 401);
      }

      // Provide specific error for rate limiting (429 Too Many Requests)
      if (errorStatus === 429) {
        throw new LlmRequestError('Rate limit exceeded. Please wait a moment or try another model.', 429);
      }

      // Any other HTTP error: report the status only. The SDK's message embeds the
      // endpoint's response body, which is logged above but must not travel back to
      // whoever chose the endpoint (a server client, through GET /scans/:id).
      if (typeof errorStatus === 'number') {
        throw new LlmRequestError(`LLM request failed with HTTP ${errorStatus}.`, errorStatus);
      }

      // Sanitize and throw generic error for other cases
      const safeMessage = sanitizeErrorMessage(error);
      // eslint-disable-next-line preserve-caught-error
      throw new Error(safeMessage || 'Failed to generate scan. Please try again.');
    }
  }
}

// --- Anthropic (Claude API) ----------------------------------------------------

const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';

/**
 * Most images one Messages API request accepts on every model: 600 on 1M-context models,
 * 100 on 200K-context ones (https://platform.claude.com/docs/en/build-with-claude/vision).
 */
export const ANTHROPIC_MAX_IMAGES = 100;

/**
 * SDK retries for an attempt that fails before its response starts streaming (connection
 * errors, 408, 409, 429, and 5xx, after any retry-after delay). A retry resends only the LLM
 * request, which costs far less than a host re-running the whole scan. A failure after the
 * stream starts is not retried here; it surfaces as retryable llm-failed.
 */
const ANTHROPIC_MAX_RETRIES = 2;

/**
 * How long one attempt may wait for its response to start. The SDK's timeout runs only
 * until the response headers arrive, so it bounds connecting and queueing, not a generation
 * that thinks for minutes: the stream then runs for as long as data keeps arriving (it is
 * cut after 5 idle minutes).
 */
const ANTHROPIC_TIMEOUT_MS = 5 * 60_000;

/**
 * Models that accept the server-side refusal fallback (`fallbacks: "default"`). Claude Haiku
 * 5.5 has none, and older models are fallback targets rather than sources
 * (https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback).
 */
const REFUSAL_FALLBACK_MODELS: ReadonlySet<string> = new Set([
  'claude-fable-5-1',
  'claude-mythos-5-1',
  'claude-fable-5',
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-sonnet-5-5',
]);

const REFUSAL_FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/** Request body of `client.beta.messages.stream`, which the SDK does not export by name. */
type BetaStreamParams = Parameters<Anthropic['beta']['messages']['stream']>[0];

/** Cache prices when `pricing` gives none: the standard read and 5-minute write multipliers. */
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

/**
 * Anthropic client that takes nothing from the environment. With apiKey, authToken, baseURL,
 * webhookKey, and logLevel passed explicitly the SDK skips ANTHROPIC_API_KEY,
 * ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL, ANTHROPIC_WEBHOOK_SIGNING_KEY, ANTHROPIC_LOG, and
 * its credential chain (profiles, workload identity). It still merges ANTHROPIC_CUSTOM_HEADERS
 * into every request after the auth headers, where it could add headers or replace the key,
 * so the constructor puts back the caller's own defaultHeaders.
 */
class EnvIsolatedAnthropic extends Anthropic {
  constructor(options: ClientOptions) {
    super(options);
    this._options = { ...this._options, defaultHeaders: options.defaultHeaders };
  }
}

/** One model attempt's token counts. After a refusal fallback there is one per model that ran. */
interface AttemptUsage {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

function attemptCounts(usage: {
  input_tokens: unknown;
  output_tokens: unknown;
  cache_read_input_tokens: unknown;
  cache_creation_input_tokens: unknown;
}): Omit<AttemptUsage, 'model'> {
  return {
    input: usageCount(usage.input_tokens) ?? 0,
    output: usageCount(usage.output_tokens) ?? 0,
    cacheRead: usageCount(usage.cache_read_input_tokens) ?? 0,
    cacheWrite: usageCount(usage.cache_creation_input_tokens) ?? 0,
  };
}

/**
 * Per-attempt usage. Top-level usage covers only the attempt that produced the message, so
 * when the response breaks usage down by iteration (it does after a fallback), every
 * iteration that ran a model is counted, each under its own model.
 */
function anthropicAttempts(message: Anthropic.Beta.BetaMessage, requestedModel: string): AttemptUsage[] {
  const iterations = (message.usage.iterations ?? []).filter(
    (entry) => entry.type === 'message' || entry.type === 'fallback_message',
  );
  if (iterations.length === 0) {
    return [{ model: String(message.model), ...attemptCounts(message.usage) }];
  }
  return iterations.map((entry) => ({ model: String(entry.model ?? requestedModel), ...attemptCounts(entry) }));
}

/**
 * Estimated USD cost, each attempt at its own model's rates. 0 unless every model that ran
 * has a pricing entry, so a partial sum never passes for the full cost.
 */
function estimateCost(
  attempts: AttemptUsage[],
  pricing: Record<string, ModelPricing>,
): { cost: number; unpriced: string[] } {
  const unpriced = [...new Set(attempts.map((a) => a.model).filter((model) => !Object.hasOwn(pricing, model)))];
  if (unpriced.length > 0) return { cost: 0, unpriced };
  let cost = 0;
  for (const attempt of attempts) {
    const price = pricing[attempt.model] as ModelPricing;
    cost +=
      attempt.input * price.inputPer1M +
      attempt.output * price.outputPer1M +
      attempt.cacheRead * (price.cacheReadPer1M ?? price.inputPer1M * CACHE_READ_MULTIPLIER) +
      attempt.cacheWrite * (price.cacheWritePer1M ?? price.inputPer1M * CACHE_WRITE_MULTIPLIER);
  }
  return { cost: cost / 1_000_000, unpriced: [] };
}

/** Refusal categories are an open set; only a plain identifier is echoed into a message. */
function refusalCategory(message: Anthropic.Beta.BetaMessage): string | null {
  const category: unknown = message.stop_details?.category;
  return typeof category === 'string' && /^[a-z_]{1,40}$/.test(category) ? category : null;
}

/**
 * Map an Anthropic SDK failure onto an engine error. Messages carry the status at most:
 * the SDK's own message embeds the response body, which is logged but must not reach
 * whoever chose the endpoint.
 */
function anthropicRequestError(error: unknown, model: string): LlmRequestError {
  if (error instanceof LlmRequestError) return error;
  const failed = (message: string, retryable: boolean, status?: number) =>
    new LlmRequestError(message, status, { code: 'llm-failed', retryable });

  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return failed('LLM request timed out.', true);
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return failed('LLM request failed: could not reach the endpoint.', true);
  }
  if (!(error instanceof Anthropic.APIError)) {
    return failed('LLM request failed.', true);
  }

  const status = error.status;
  if (status === undefined) {
    // An error event after the stream had started (overloaded, server error).
    return failed('LLM request failed while streaming the response.', true);
  }
  // A tier spend cap arrives as a 429 that names this code; retrying fails until the cap resets.
  const body = error.error as { error?: { details?: { error_code?: unknown } } } | undefined;
  if (status === 402 || body?.error?.details?.error_code === 'enforced_spend_limit_reached') {
    return new LlmRequestError(
      `The Anthropic account is out of credit or over its spend limit (HTTP ${status}).`,
      status,
      { code: 'llm-billing', retryable: false },
    );
  }
  if (error instanceof Anthropic.AuthenticationError) {
    return new LlmRequestError('API key is invalid or expired. Please check your Anthropic API key.', status, {
      code: 'llm-auth',
      retryable: false,
    });
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    return new LlmRequestError('The API key is not allowed to make this request (HTTP 403).', status, {
      code: 'llm-auth',
      retryable: false,
    });
  }
  if (error instanceof Anthropic.NotFoundError) {
    return failed(`Model "${model}" was not found or is not available to this API key (HTTP 404).`, false, status);
  }
  // Retryable, unlike OpenRouter's: the capacity belongs to the key owner, so it comes back.
  if (error instanceof Anthropic.RateLimitError) {
    return new LlmRequestError('Rate limited. Try again shortly.', status, { code: 'llm-rate-limit', retryable: true });
  }
  return failed(`LLM request failed with HTTP ${status}.`, status >= 500 || status === 408, status);
}

class AnthropicProvider implements LlmProviderClient {
  private readonly baseUrl: string;
  private readonly allowPrivateNetworks: boolean;
  private readonly pricing: Record<string, ModelPricing>;
  private readonly refusalFallback: boolean;

  constructor(config: LLMServiceConfig) {
    this.baseUrl = config.baseUrl ?? ANTHROPIC_BASE_URL;
    this.allowPrivateNetworks = config.allowPrivateNetworks ?? false;
    this.pricing = config.pricing ?? {};
    this.refusalFallback = config.refusalFallback ?? true;
  }

  private createClient(apiKey: string): Anthropic {
    return new EnvIsolatedAnthropic({
      apiKey,
      authToken: null,
      baseURL: this.baseUrl,
      webhookKey: null,
      // The engine logs failures itself, through the scan's logger.
      logLevel: 'off',
      maxRetries: ANTHROPIC_MAX_RETRIES,
      timeout: ANTHROPIC_TIMEOUT_MS,
      // The SDK uses fetch, which has no agent hook, so the same connection guard the
      // OpenRouter client gets comes in through a guarded fetch.
      ...(this.allowPrivateNetworks ? {} : { fetch: createGuardedFetch(new URL(this.baseUrl).protocol) }),
    });
  }

  async generate({ prompt, systemPrompt, model, apiKey, tiles, params, log }: GenerateRequest): Promise<ScanResult> {
    if (tiles.length > ANTHROPIC_MAX_IMAGES) {
      throw new LlmRequestError(
        `The page screenshot needs ${tiles.length} image tiles, but one Anthropic request accepts at most ${ANTHROPIC_MAX_IMAGES}.`,
        undefined,
        { code: 'llm-failed', retryable: false },
      );
    }

    const useFallback = this.refusalFallback && REFUSAL_FALLBACK_MODELS.has(model);
    // No temperature, top_p, or frequency penalty: current Claude models reject non-default
    // sampling values and the API has no frequency penalty. No `thinking` either: current
    // models think adaptively by default, and Opus 5.5 cannot turn it off.
    const request: BetaStreamParams = {
      model,
      max_tokens: params.maxTokens,
      // The system prompt is identical across scans, so it is cached.
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            ...tiles.map((data) => ({
              type: 'image' as const,
              source: { type: 'base64' as const, media_type: 'image/jpeg' as const, data },
            })),
          ],
        },
      ],
      ...(params.effort ? { output_config: { effort: params.effort } } : {}),
      ...(useFallback ? { fallbacks: 'default' as const, betas: [REFUSAL_FALLBACK_BETA] } : {}),
    };

    const startTime = Date.now();
    let message: Anthropic.Beta.BetaMessage;
    try {
      message = await this.createClient(apiKey).beta.messages.stream(request).finalMessage();
    } catch (error: unknown) {
      const cause = (error as { cause?: unknown })?.cause;
      log.error('LLM API error', {
        durationMs: Date.now() - startTime,
        model,
        status: (error as { status?: number })?.status,
        errorName: error instanceof Error ? error.name : 'Unknown',
        providerError: sanitizeErrorMessage(error),
        // Connection failures (including a guarded-fetch refusal) carry the reason here.
        ...(cause instanceof Error ? { cause: sanitizeErrorMessage(cause) } : {}),
      });
      // Not chained as `cause`, for the same reason as the OpenRouter path.
      throw anthropicRequestError(error, model);
    }

    // A refusal or a cut-off response can still carry text; neither is a usable scan.
    if (message.stop_reason === 'refusal') {
      const category = refusalCategory(message);
      log.warn('LLM refused the request', { model, servedModel: message.model, category });
      throw new LlmRequestError(
        category
          ? `The model declined to analyze this page (refusal category: ${category}).`
          : 'The model declined to analyze this page.',
        undefined,
        { code: 'llm-refused', retryable: false },
      );
    }
    if (message.stop_reason === 'max_tokens') {
      throw new LlmRequestError(
        `The model's response was cut off at the ${params.maxTokens}-token output limit (generationParams.maxTokens).`,
        undefined,
        { code: 'llm-malformed', retryable: false },
      );
    }

    // Thinking and fallback blocks come back in the content too; the answer is the text.
    const content = message.content
      .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    const attempts = anthropicAttempts(message, model);
    const { cost, unpriced } = estimateCost(attempts, this.pricing);
    if (unpriced.length > 0 && Object.keys(this.pricing).length > 0) {
      log.warn('No pricing for a model that ran; reporting cost 0', { models: unpriced });
    }
    const sum = (key: Exclude<keyof AttemptUsage, 'model'>) => attempts.reduce((total, a) => total + a[key], 0);
    const cachedTokens = sum('cacheRead');
    const cacheWriteTokens = sum('cacheWrite');
    const promptTokens = sum('input') + cachedTokens + cacheWriteTokens;
    const completionTokens = sum('output');

    return {
      content,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
        cost,
        modelId: model,
        cachedTokens,
        cacheWriteTokens,
        reasoningTokens: usageCount(message.usage.output_tokens_details?.thinking_tokens),
        ...(typeof message.model === 'string' ? { servedModelId: message.model } : {}),
      },
    };
  }
}

// --- Service ---------------------------------------------------------------------

export class LLMService {
  private readonly provider: LlmProvider;
  private readonly client: LlmProviderClient;
  private readonly debug: boolean;

  constructor(config: LLMServiceConfig = {}) {
    this.provider = config.provider ?? 'openrouter';
    this.client = this.provider === 'anthropic' ? new AnthropicProvider(config) : new OpenRouterProvider(config);
    this.debug = config.debug ?? false;
  }

  async generateScan(
    prompt: string,
    systemPrompt: string,
    model: string,
    apiKey: string,
    screenshotTiles?: string[],
    jobLogger?: Logger,
    generationParams?: GenerationParams,
  ): Promise<ScanResult> {
    const log = jobLogger || defaultLogger;

    const startTime = Date.now();
    const imageCount = screenshotTiles?.length || 0;
    const isDebugMode = this.debug;

    // Calculate approximate image sizes for debugging
    const imageSizes = screenshotTiles?.map((tile, i) => ({
      tile: i + 1,
      sizeKB: Math.round((tile.length * 3) / 4 / 1024), // Base64 to bytes, then to KB
    }));

    // Use provided generation params or fall back to defaults (for logging)
    const effectiveParams = generationParams || DEFAULT_GENERATION_PARAMS;

    log.info('LLM request starting', {
      provider: this.provider,
      model,
      imageCount,
      imageSizes,
      promptLength: prompt.length,
      systemPromptLength: systemPrompt.length,
      generationParams: effectiveParams,
    });

    // Debug mode: log the actual prompt content for comparison
    if (isDebugMode) {
      // Find HTML section in prompt (full content, no truncation for debugging)
      const htmlSectionStart = prompt.indexOf('## HTML Structure');
      const htmlSectionEnd = prompt.indexOf('## Output Requirements');
      const htmlSection =
        htmlSectionStart !== -1 && htmlSectionEnd !== -1
          ? prompt.substring(htmlSectionStart, htmlSectionEnd)
          : 'NOT FOUND';

      // Find A11y tree section (full content for debugging)
      const a11ySectionStart = prompt.indexOf('## Accessibility Tree');
      const a11ySectionEnd = prompt.indexOf('## HTML Structure');
      const a11ySection =
        a11ySectionStart !== -1 && a11ySectionEnd !== -1
          ? prompt.substring(a11ySectionStart, a11ySectionEnd)
          : 'NOT FOUND';

      log.info('LLM_DEBUG: Full prompt content', {
        model,
        imageCount,
        totalPromptLength: prompt.length,
        // Check if prompt mentions tiles
        mentionsTiles: prompt.includes('tiles') || prompt.includes('Tile'),
        // Check if HTML is included
        hasHtmlSection: prompt.includes('## HTML Structure'),
        htmlSectionLength: htmlSectionEnd !== -1 && htmlSectionStart !== -1 ? htmlSectionEnd - htmlSectionStart : 0,
        // Log section around Visual Analysis
        visualAnalysisSection: prompt.includes('Visual Analysis')
          ? prompt.substring(prompt.indexOf('Visual Analysis'), prompt.indexOf('Visual Analysis') + 500)
          : 'NOT FOUND',
        // Log full HTML section (no truncation for debugging)
        htmlSectionFull: htmlSection,
        // Log full A11y tree section
        a11ySectionFull: a11ySection,
      });
    }

    const result = await this.client.generate({
      prompt,
      systemPrompt,
      model,
      apiKey,
      tiles: screenshotTiles ?? [],
      params: effectiveParams,
      log,
    });
    const { content, usage } = result;

    const duration = Date.now() - startTime;

    // Debug mode: analyze the response
    if (isDebugMode) {
      // Try to parse JSON and count issues (strip markdown if needed)
      try {
        let cleanContent = content.trim();
        // Strip markdown code blocks if present
        if (cleanContent.startsWith('```json')) {
          cleanContent = cleanContent.replace(/^```json\s*\n?/, '').replace(/\n?```\s*$/, '');
        } else if (cleanContent.startsWith('```')) {
          cleanContent = cleanContent.replace(/^```\s*\n?/, '').replace(/\n?```\s*$/, '');
        }
        // Find JSON object boundaries
        const firstBrace = cleanContent.indexOf('{');
        const lastBrace = cleanContent.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace !== -1) {
          cleanContent = cleanContent.substring(firstBrace, lastBrace + 1);
        }

        const parsed = JSON.parse(cleanContent);
        log.info('LLM_DEBUG: Response analysis', {
          model,
          imageCount,
          responseLength: content.length,
          hadMarkdownWrapper: content.trim().startsWith('```'),
          issueCount: parsed.issues?.length || 0,
          criticalCount: parsed.issues?.filter((i: { severity: string }) => i.severity === 'critical').length || 0,
          highCount: parsed.issues?.filter((i: { severity: string }) => i.severity === 'high').length || 0,
          mediumCount: parsed.issues?.filter((i: { severity: string }) => i.severity === 'medium').length || 0,
          lowCount: parsed.issues?.filter((i: { severity: string }) => i.severity === 'low').length || 0,
          wcagCoverageCount: parsed.wcagCoverage?.length || 0,
          passedChecksCount: parsed.passedChecks?.length || 0,
          // Show first few issue titles to compare
          issueTitles: parsed.issues?.slice(0, 5).map((i: { title: string }) => i.title) || [],
        });
      } catch (e) {
        log.warn('LLM_DEBUG: Could not parse response as JSON', {
          model,
          error: e instanceof Error ? e.message : String(e),
          responsePreview: content.substring(0, 500),
        });
      }
    }

    log.info('LLM analysis complete', {
      durationMs: duration,
      responseLength: content.length,
      promptTokens: usage?.promptTokens,
      completionTokens: usage?.completionTokens,
      totalTokens: usage?.totalTokens,
      cost: usage?.cost,
      cachedTokens: usage?.cachedTokens,
      reasoningTokens: usage?.reasoningTokens,
    });

    return result;
  }
}

// Export a singleton
export const llmService = new LLMService();
