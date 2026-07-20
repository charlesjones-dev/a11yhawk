import OpenAI from 'openai';
import type {
  ChatCompletionMessageParam,
  ChatCompletionContentPart,
  ChatCompletionCreateParamsNonStreaming,
} from 'openai/resources/chat/completions';
import type { Logger } from '../logger/index.js';
import { createLogger } from '../logger/index.js';

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
    reasoningTokens?: number;
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

/**
 * Configuration for the LLM service (previously sourced from environment variables)
 */
export interface LLMServiceConfig {
  baseUrl?: string;
  httpReferer?: string;
  appTitle?: string;
  debug?: boolean;
}

export class LLMService {
  private readonly baseUrl: string;
  private readonly httpReferer: string;
  private readonly appTitle: string;
  private readonly debug: boolean;

  constructor(config: LLMServiceConfig = {}) {
    this.baseUrl = config.baseUrl ?? 'https://openrouter.ai/api/v1';
    this.httpReferer = config.httpReferer ?? 'https://github.com/charlesjones-dev/a11yhawk';
    this.appTitle = config.appTitle ?? 'A11yHawk';
    this.debug = config.debug ?? false;
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
    });
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
    // Build user content parts
    const userContent: ChatCompletionContentPart[] = [{ type: 'text', text: prompt }];

    // Add images if provided (may be multiple tiles for long pages)
    if (screenshotTiles && screenshotTiles.length > 0) {
      for (let i = 0; i < screenshotTiles.length; i++) {
        userContent.push({
          type: 'image_url',
          image_url: {
            url: `data:image/jpeg;base64,${screenshotTiles[i]}`,
            // Note: 'detail' parameter is OpenAI-specific, omit for cross-provider compatibility
          },
        });
      }
    }

    const messages: ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ];

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

    try {
      const client = this.createClient(apiKey);

      // OpenRouter supports a 'usage' parameter to include token/cost data in the response.
      // Since this is not in the OpenAI SDK types, we need to cast to bypass type checking.
      const completion = await client.chat.completions.create({
        model: model,
        messages: messages,
        temperature: effectiveParams.temperature,
        max_tokens: effectiveParams.maxTokens,
        top_p: effectiveParams.topP,
        frequency_penalty: effectiveParams.frequencyPenalty,
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
          promptTokens: usageData.prompt_tokens || 0,
          completionTokens: usageData.completion_tokens || 0,
          totalTokens: usageData.total_tokens || 0,
          cost: usageData.cost || 0,
          modelId: model,
          cachedTokens: usageData.prompt_tokens_details?.cached_tokens,
          reasoningTokens: usageData.completion_tokens_details?.reasoning_tokens,
        };
      }

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
      log.error('LLM API error', {
        durationMs: duration,
        model,
        status: errorStatus,
        errorName: error instanceof Error ? error.name : 'Unknown',
        providerError: providerError || errorResponse?.message || errorMessage,
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
      if (errorStatus === 401 || errorMessage?.includes('401')) {
        // eslint-disable-next-line preserve-caught-error
        throw new Error('API key is invalid or expired. Please check your OpenRouter API key.');
      }

      // Provide specific error for rate limiting (429 Too Many Requests)
      if (errorStatus === 429 || errorMessage?.includes('429')) {
        // eslint-disable-next-line preserve-caught-error
        throw new Error('Rate limit exceeded. Please wait a moment or try another model.');
      }

      // Sanitize and throw generic error for other cases
      const safeMessage = sanitizeErrorMessage(error);
      // eslint-disable-next-line preserve-caught-error
      throw new Error(safeMessage || 'Failed to generate scan. Please try again.');
    }
  }
}

// Export a singleton
export const llmService = new LLMService();
