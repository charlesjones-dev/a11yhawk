import { chromium, type Browser, type BrowserServer } from 'playwright';
import sharp from 'sharp';
import net from 'net';
import type { ScanHeader } from '../types.js';
import type { Logger } from '../logger/index.js';
import { createLogger } from '../logger/index.js';
import { installRequestGuard } from './request-guard.js';

/**
 * Allocate a free TCP port by opening an ephemeral listener and reading back
 * the OS-assigned port. Used so Chromium can be launched with an explicit
 * --remote-debugging-port that Lighthouse can reconnect to via --port.
 */
async function getFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      if (address && typeof address === 'object') {
        const port = address.port;
        srv.close(() => resolve(port));
      } else {
        srv.close();
        reject(new Error('Failed to determine free port'));
      }
    });
  });
}

/**
 * Provider-specific maximum image dimension limits.
 * Only Anthropic returns hard errors; others auto-scale internally.
 * Sources:
 * - Anthropic: https://docs.claude.com/en/docs/build-with-claude/vision (8000px hard limit)
 * - OpenAI: https://platform.openai.com/docs/guides/images-vision (2048px, auto-scales)
 * - Google: https://ai.google.dev/gemini-api/docs/image-understanding (3072px, auto-scales)
 */
export const PROVIDER_IMAGE_LIMITS: Record<string, number> = {
  anthropic: 8000, // Hard limit - returns error if exceeded
  openai: 2048, // Auto-scales, but we can pre-split for multi-image context
  google: 3072, // Auto-scales, but we can pre-split for multi-image context
  'x-ai': 8000, // Grok - assume similar to Claude (conservative)
  mistralai: 4096, // Mistral - conservative estimate
  meta: 4096, // Llama - conservative estimate
  default: 2048, // Conservative fallback
};

/**
 * Get the max image dimension for a given model ID.
 * Extracts provider from model ID prefix (e.g., "anthropic/claude-sonnet-4.5" -> "anthropic")
 */
export function getMaxImageDimension(modelId: string): number {
  const provider = modelId.split('/')[0]?.toLowerCase() || 'default';
  return PROVIDER_IMAGE_LIMITS[provider] ?? PROVIDER_IMAGE_LIMITS.default ?? 2048;
}

const defaultLogger = createLogger({ serviceName: 'worker' });

/**
 * Split an image into vertical tiles to fit LLM provider dimension limits.
 * Strategy: Maintain original width for accurate horizontal analysis.
 * If height exceeds limit, split into multiple tiles (no content lost).
 * Returns array of base64 strings for LLM, original buffer preserved for S3.
 */
async function splitImageIntoTiles(
  buffer: Buffer,
  maxDimension: number,
  log: Logger,
): Promise<{ tiles: string[]; tileCount: number }> {
  const image = sharp(buffer);
  const metadata = await image.metadata();

  const width = metadata.width || 0;
  const height = metadata.height || 0;

  // Check if splitting is needed
  if (width <= maxDimension && height <= maxDimension) {
    // Single image, no splitting needed
    const base64 = buffer.toString('base64');
    return { tiles: [base64], tileCount: 1 };
  }

  // If width exceeds limit (rare with 1920px viewport), resize proportionally first
  let processedBuffer = buffer;
  let processedWidth = width;
  let processedHeight = height;

  if (width > maxDimension) {
    const scale = maxDimension / width;
    processedWidth = maxDimension;
    processedHeight = Math.round(height * scale);
    processedBuffer = await sharp(buffer).resize(processedWidth, processedHeight).jpeg({ quality: 60 }).toBuffer();
    log.info('Resizing screenshot width to fit provider limits', {
      originalWidth: width,
      originalHeight: height,
      newWidth: processedWidth,
      newHeight: processedHeight,
    });
  }

  // If height exceeds limit, split into vertical tiles
  if (processedHeight <= maxDimension) {
    const base64 = processedBuffer.toString('base64');
    return { tiles: [base64], tileCount: 1 };
  }

  const tileCount = Math.ceil(processedHeight / maxDimension);
  const tiles: string[] = [];

  log.info('Splitting screenshot into vertical tiles', {
    width: processedWidth,
    height: processedHeight,
    maxDimension,
    tileCount,
  });

  for (let i = 0; i < tileCount; i++) {
    const top = i * maxDimension;
    const tileHeight = Math.min(maxDimension, processedHeight - top);

    const tileBuffer = await sharp(processedBuffer)
      .extract({ left: 0, top, width: processedWidth, height: tileHeight })
      .jpeg({ quality: 60 })
      .toBuffer();

    tiles.push(tileBuffer.toString('base64'));
  }

  return { tiles, tileCount };
}

export interface PageAnalysisResult {
  title: string;
  screenshotBuffer: Buffer | null; // Raw buffer for direct S3 upload (full page)
  screenshotTiles: string[]; // Base64 tiles for LLM analysis (may be split for long pages)
  accessibilityTree: Record<string, unknown> | null;
  html: string;
  finalUrl: string; // URL after redirects - every hop was validated by the request guard
}

// Interface for accessibility tree nodes
interface A11yNode {
  role?: string;
  name?: string;
  description?: string;
  value?: string;
  children?: A11yNode[];
  [key: string]: unknown; // Allow index signature for Record<string, unknown> compatibility
}

// CDP Accessibility node type (from Chrome DevTools Protocol)
interface CDPAXNode {
  nodeId: string;
  parentId?: string;
  role?: { value?: string };
  name?: { value?: string };
  description?: { value?: string };
  value?: { value?: string };
  childIds?: string[];
  ignored?: boolean;
}

// Build a hierarchical accessibility tree from CDP flat node list
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildAccessibilityTree(nodes: any[]): A11yNode | null {
  if (!nodes || nodes.length === 0) return null;

  // Create a map of nodeId -> node for quick lookup
  const nodeMap = new Map<string, A11yNode & { nodeId: string }>();

  // First pass: create all nodes
  // Note: We include 'ignored' nodes because they may represent accessibility issues
  // (hidden content, missing roles, etc.) that our scanner should detect
  for (const cdpNode of nodes as CDPAXNode[]) {
    const node: A11yNode & { nodeId: string } = {
      nodeId: cdpNode.nodeId,
      role: cdpNode.role?.value,
      children: [],
    };

    // Add name if present
    if (cdpNode.name?.value) {
      node.name = cdpNode.name.value;
    }

    // Add description if present
    if (cdpNode.description?.value) {
      node.description = cdpNode.description.value;
    }

    // Add value if present
    if (cdpNode.value?.value) {
      node.value = cdpNode.value.value;
    }

    nodeMap.set(cdpNode.nodeId, node);
  }

  // Second pass: build parent-child relationships
  let root: A11yNode | null = null;

  for (const cdpNode of nodes as CDPAXNode[]) {
    const node = nodeMap.get(cdpNode.nodeId);
    if (!node) continue;

    if (cdpNode.parentId) {
      const parent = nodeMap.get(cdpNode.parentId);
      if (parent && parent.children) {
        parent.children.push(node);
      }
    } else {
      // This is the root node
      root = node;
    }
  }

  return root;
}

// Count accessibility tree elements by traversing the tree instead of JSON serialization + regex
// This avoids creating large intermediate strings (100-500KB) just for counting elements
function countA11yElements(node: A11yNode | null): { total: number; images: number; buttons: number; links: number } {
  const counts = { total: 0, images: 0, buttons: 0, links: 0 };
  if (!node) return counts;

  function traverse(n: A11yNode) {
    if (n.role) {
      counts.total++;
      if (n.role === 'img') counts.images++;
      if (n.role === 'button') counts.buttons++;
      if (n.role === 'link') counts.links++;
    }
    if (n.children) {
      for (const child of n.children) {
        traverse(child);
      }
    }
  }

  traverse(node);
  return counts;
}

export interface PlaywrightServiceOptions {
  /**
   * Launch Chromium with --no-sandbox / --disable-setuid-sandbox. Only for containerized
   * environments that restrict kernel namespaces; a critical security risk otherwise.
   * Default false.
   */
  disableSandbox?: boolean;
  /**
   * Emit extra progress messages during capture (e.g. screenshot tiling). Logging only,
   * no behavioral effect. Default false.
   */
  debug?: boolean;
  /**
   * Permit scanning private, loopback, and link-local targets end to end by threading into
   * the SSRF request guard. Every other request-guard protection stays active. Default false.
   */
  allowPrivateNetworks?: boolean;
}

export class PlaywrightService {
  private browser: Browser | null = null;
  private browserServer: BrowserServer | null = null;
  private cdpPort: number | null = null;
  private browserRefCount = 0;
  private activeAnalyses = 0;
  private maxConcurrentAnalyses: number;
  private readonly disableSandbox: boolean;
  private readonly debug: boolean;
  private readonly allowPrivateNetworks: boolean;

  constructor(options: PlaywrightServiceOptions = {}) {
    // Default concurrency - will be overridden by setConcurrency() after MongoDB config loads
    this.maxConcurrentAnalyses = 3;
    this.disableSandbox = options.disableSandbox ?? false;
    this.debug = options.debug ?? false;
    this.allowPrivateNetworks = options.allowPrivateNetworks ?? false;
  }

  setConcurrency(concurrency: number): void {
    this.maxConcurrentAnalyses = concurrency;
  }

  /**
   * Get the Chromium remote debugging (CDP) port bound via --remote-debugging-port.
   * This is the port Lighthouse should connect to via `--port=N` to reuse the
   * existing Chromium instead of launching its own.
   *
   * Note: This is NOT the Playwright WebSocket port from `browserServer.wsEndpoint()`.
   * Playwright's protocol and Chrome DevTools Protocol use different endpoints.
   *
   * @returns The CDP port number, or null if browser is not running
   */
  getCDPPort(): number | null {
    return this.cdpPort;
  }

  /**
   * Get the full CDP WebSocket endpoint URL.
   * This can be used for tools that need the complete WebSocket URL.
   *
   * @returns The WebSocket endpoint URL, or null if browser is not running
   */
  getCDPEndpoint(): string | null {
    if (!this.browserServer) {
      return null;
    }

    try {
      return this.browserServer.wsEndpoint();
    } catch {
      return null;
    }
  }

  // Promise-based queue instead of polling for concurrency control
  private waitingQueue: Array<() => void> = [];

  async initialize(jobLogger?: Logger) {
    const log = jobLogger || defaultLogger;

    if (!this.browser) {
      // Allocate an explicit CDP port so Lighthouse can reconnect to this same
      // Chromium instead of spawning a second one. Chrome listens for CDP on
      // this port alongside Playwright's own protocol on the WebSocket endpoint.
      this.cdpPort = await getFreePort();

      // Build browser args based on environment
      const args = [
        '--disable-blink-features=AutomationControlled', // Hide automation - SAFE for bot bypass
        '--disable-dev-shm-usage', // Memory optimization for containers - SAFE
        `--remote-debugging-port=${this.cdpPort}`,
        '--remote-debugging-address=127.0.0.1',
      ];

      // SECURITY NOTE: --no-sandbox is a critical security risk but may be required
      // in containerized environments like Railway that restrict kernel namespaces.
      // Only enable if deployment requires it. Consider these compensating controls:
      // 1. Network isolation for browser process
      // 2. Strict URL validation (see url-validator.ts)
      // 3. Resource limits and timeouts (implemented below)
      if (this.disableSandbox) {
        log.warn('Chromium sandbox is DISABLED - critical security risk');
        args.push('--no-sandbox', '--disable-setuid-sandbox');
      }

      log.info('Launching browser server', { cdpPort: this.cdpPort });
      this.browserServer = await chromium.launchServer({
        headless: true,
        args,
        timeout: 30000, // 30 second timeout for browser launch
      });

      // Connect to the browser server to get a Browser instance for page operations
      this.browser = await chromium.connect(this.browserServer.wsEndpoint());

      log.info('Browser server ready', { cdpPort: this.cdpPort });
    }
  }

  /**
   * Acquire a reference to the shared browser for the duration of a scan.
   * Launches Chromium if it isn't already running. The caller MUST pair
   * every acquire with a release in a finally block so the browser shuts
   * down when the last consumer is done.
   */
  async acquireBrowser(jobLogger?: Logger): Promise<void> {
    this.browserRefCount++;
    await this.initialize(jobLogger);
  }

  /**
   * Release the browser reference. When the count hits zero, Chromium is
   * shut down to release its native memory back to the OS. The next
   * acquire() will relaunch it from scratch.
   */
  async releaseBrowser(jobLogger?: Logger): Promise<void> {
    this.browserRefCount = Math.max(0, this.browserRefCount - 1);
    if (this.browserRefCount === 0 && this.browser) {
      const log = jobLogger || defaultLogger;
      log.info('Closing browser - no active scans');
      await this.cleanup();
    }
  }

  async cleanup() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }

    if (this.browserServer) {
      await this.browserServer.close();
      this.browserServer = null;
    }

    this.cdpPort = null;
  }

  private async waitForSlot(): Promise<void> {
    // Use Promise-based queue instead of polling
    // If a slot is immediately available, return right away
    if (this.activeAnalyses < this.maxConcurrentAnalyses) {
      return;
    }

    // Otherwise, wait for a signal from releaseSlot()
    return new Promise<void>((resolve) => {
      this.waitingQueue.push(resolve);
    });
  }

  private releaseSlot(): void {
    this.activeAnalyses = Math.max(0, this.activeAnalyses - 1);
    defaultLogger.debug('Released concurrency slot', {
      activeAnalyses: this.activeAnalyses,
      maxConcurrent: this.maxConcurrentAnalyses,
    });

    // Signal the next waiting request if any
    const next = this.waitingQueue.shift();
    if (next) {
      defaultLogger.debug('Signaling next waiting request', { queueLength: this.waitingQueue.length });
      next();
    }
  }

  async analyzePage(
    url: string,
    modelId: string,
    onProgress?: (message: string) => void,
    onScreenshot?: (screenshotBase64: string) => void,
    customHeaders?: ScanHeader[],
    jobLogger?: Logger,
  ): Promise<PageAnalysisResult> {
    const log = jobLogger || defaultLogger;

    // Concurrency limiting to prevent memory spikes
    if (this.activeAnalyses >= this.maxConcurrentAnalyses) {
      onProgress?.('Waiting for other scans to complete...');
      await this.waitForSlot();
    }

    this.activeAnalyses++;
    log.info('Playwright capture starting', {
      activeAnalyses: this.activeAnalyses,
      maxConcurrent: this.maxConcurrentAnalyses,
    });
    onProgress?.(`Starting analysis of ${url}...`);

    const startTime = Date.now();
    await this.initialize(jobLogger);

    const browserLaunchTime = Date.now() - startTime;
    if (browserLaunchTime > 100) {
      onProgress?.(`Browser ready (${(browserLaunchTime / 1000).toFixed(1)}s)`);
    }

    // Set maximum operation timeout (compensating control for disabled sandbox)
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const operationPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error('Page analysis timeout - operation took too long (90s limit)'));
      }, 90000); // 90 seconds max for entire operation
    });

    // Build extra HTTP headers (default + custom headers)
    const extraHTTPHeaders: Record<string, string> = {
      'Accept-Language': 'en-US,en;q=0.9',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Sec-Ch-Ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"Windows"',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1',
    };

    // Apply custom headers
    if (customHeaders && customHeaders.length > 0) {
      let headerCount = 0;
      let cookieCount = 0;
      let authCount = 0;

      for (const header of customHeaders) {
        if (header.type === 'header') {
          // Add custom header
          extraHTTPHeaders[header.key] = header.value;
          headerCount++;
        } else if (header.type === 'authorization') {
          // Add Bearer token to Authorization header
          extraHTTPHeaders['Authorization'] = `Bearer ${header.value}`;
          authCount++;
        }
        // Cookies will be handled separately via context.addCookies()
        else if (header.type === 'cookie') {
          cookieCount++;
        }
      }

      // Security: log counts only, not values
      log.info('Custom headers prepared', { headerCount, authCount, cookieCount });
      onProgress?.(`Custom headers applied (${headerCount} headers, ${authCount} auth, ${cookieCount} cookies)`);
    }

    const context = await this.browser!.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 }, // Full HD for accurate desktop accessibility scanning
      locale: 'en-US',
      timezoneId: 'America/New_York',
      extraHTTPHeaders,
      // Service workers can issue fetches that bypass page.route interception, which
      // would punch a hole in the SSRF request guard - block them (security audit H-1).
      serviceWorkers: 'block',
    });

    // Apply cookies if present
    if (customHeaders && customHeaders.length > 0) {
      const cookies = customHeaders
        .filter((h) => h.type === 'cookie')
        .map((h) => ({
          name: h.key,
          value: h.value,
          url, // Cookie is scoped to the target URL
        }));

      if (cookies.length > 0) {
        await context.addCookies(cookies);
        log.debug('Applied cookies to context', { cookieCount: cookies.length });
      }
    }

    const page = await context.newPage();

    // Remove webdriver property to avoid detection
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined,
      });
    });

    // SSRF guard (security audit H-1): validates every request the context makes
    // (including popups, redirect targets, per-request DNS re-resolution).
    const requestGuard = await installRequestGuard(context, page, log, {
      allowPrivateNetworks: this.allowPrivateNetworks,
    });

    try {
      // Race between analysis and timeout
      const result = await Promise.race([
        (async () => {
          // Navigate to the URL
          onProgress?.('Navigating to webpage...');
          log.debug('Navigating to URL');
          const navStartTime = Date.now();

          await page.goto(url, {
            waitUntil: 'domcontentloaded', // Less strict than 'networkidle', better for slow sites
            timeout: 60000, // 60 seconds for navigation
          });

          const navTime = Date.now() - navStartTime;
          onProgress?.(`Page loaded in ${(navTime / 1000).toFixed(1)}s`);

          // Use dynamic waiting based on network activity instead of fixed delay
          // Wait for networkidle first, then add 2s for slow rendering/animations
          onProgress?.('Waiting for page to settle...');
          try {
            await page.waitForLoadState('networkidle', { timeout: 5000 });
            // Additional 2s wait after networkidle for slow rendering pages
            await page.waitForTimeout(2000);
          } catch {
            // If networkidle times out, page is likely still interactive enough
            // Use 3s fallback to account for rendering time
            await page.waitForTimeout(3000);
          }

          // Get page title
          const title = await page.title();
          log.info('Page navigation complete', { title, navTimeMs: navTime });
          onProgress?.(`Analyzing: "${title}"`);

          // Scroll through the page slowly to trigger scroll-based animations before screenshot
          // This ensures lazy-loaded content and scroll-reveal animations are visible
          onProgress?.('Scrolling page to trigger animations...');
          log.debug('Scrolling page to trigger animations');

          // Execute scroll animation in browser context with adaptive timing
          // Shorter pages get faster scroll delays to reduce scan time
          // Using string to avoid TypeScript DOM type errors in server context
          const scrollInfo = (await page.evaluate(`(async () => {
            const scrollHeight = document.documentElement.scrollHeight;
            const viewportHeight = window.innerHeight;
            const scrollRatio = scrollHeight / viewportHeight;

            // Adaptive delays based on page height
            // Short pages (< 2 viewports): fast delays
            // Medium pages (2-4 viewports): moderate delays
            // Long pages (> 4 viewports): full delays for animation triggering
            let scrollDelay, bottomWait, scrollBackWait;
            if (scrollRatio <= 1.1) {
              // No scrolling needed - page fits in viewport
              return { scrollRatio, skipped: true };
            } else if (scrollRatio <= 2) {
              scrollDelay = 150;
              bottomWait = 250;
              scrollBackWait = 400;
            } else if (scrollRatio <= 4) {
              scrollDelay = 200;
              bottomWait = 350;
              scrollBackWait = 600;
            } else {
              scrollDelay = 300;
              bottomWait = 500;
              scrollBackWait = 1000;
            }

            const scrollStep = viewportHeight * 0.8;
            let currentPosition = 0;
            while (currentPosition < scrollHeight) {
              currentPosition += scrollStep;
              window.scrollTo({ top: currentPosition, behavior: 'smooth' });
              await new Promise(resolve => setTimeout(resolve, scrollDelay));
            }

            await new Promise(resolve => setTimeout(resolve, bottomWait));

            window.scrollTo({ top: 0, behavior: 'smooth' });
            await new Promise(resolve => setTimeout(resolve, scrollBackWait));

            return { scrollRatio, skipped: false };
          })()`)) as { scrollRatio: number; skipped: boolean };

          // Adaptive wait after scroll - shorter for pages that didn't need much scrolling
          const postScrollWait = scrollInfo.skipped ? 100 : scrollInfo.scrollRatio <= 2 ? 250 : 500;
          await page.waitForTimeout(postScrollWait);

          // Capture full-page screenshot - using JPEG with quality compression for memory efficiency
          onProgress?.('Capturing full-page screenshot...');
          log.info('Capturing full-page screenshot');
          const screenshotBuffer = await page.screenshot({
            fullPage: true, // Capture entire scrollable page for comprehensive accessibility scanning
            type: 'jpeg',
            quality: 60, // Reduced quality for token efficiency - still readable for contrast/a11y analysis
          });

          // Split into tiles if needed to fit LLM provider limits (varies by provider)
          const maxDimension = getMaxImageDimension(modelId);
          const { tiles: screenshotTiles, tileCount } = await splitImageIntoTiles(screenshotBuffer, maxDimension, log);

          if (this.debug) {
            if (tileCount > 1) {
              onProgress?.(`Screenshot split into ${tileCount} tiles for LLM analysis`);
            }
          }

          // Stream the first tile (or full image if no split) immediately via callback
          // This sends a preview to the client before LLM processing
          const previewTile = screenshotTiles[0];
          if (previewTile) {
            onScreenshot?.(previewTile);
          }

          // Get Accessibility Tree using CDP (Chrome DevTools Protocol)
          // The page.accessibility API was removed in Playwright 1.50+
          onProgress?.('Extracting accessibility tree...');
          log.info('Extracting accessibility tree');
          const client = await page.context().newCDPSession(page);
          const { nodes } = await client.send('Accessibility.getFullAXTree');

          // CRITICAL: Detach CDP session to prevent memory leaks
          // CDP sessions hold references to the page and must be explicitly closed
          await client.detach();

          // Debug: log CDP response statistics
          const totalNodes = nodes.length;
          const ignoredNodes = nodes.filter((n: CDPAXNode) => n.ignored).length;
          log.debug('CDP accessibility tree extracted', {
            totalNodes,
            ignoredNodes,
            activeNodes: totalNodes - ignoredNodes,
          });

          // Convert CDP AX tree to a hierarchical structure similar to the old accessibility.snapshot()
          const snapshot = buildAccessibilityTree(nodes);

          // Get simplified HTML
          onProgress?.('Extracting HTML structure...');
          const html = await page.content();

          // Calculate statistics using tree traversal (avoids large JSON string creation)
          const htmlSizeKB = (html.length / 1024).toFixed(1);
          const stats = countA11yElements(snapshot);

          onProgress?.(
            `Captured ${stats.total} elements (${stats.links} links, ${stats.buttons} buttons, ${stats.images} images)`,
          );
          onProgress?.(`Analyzing ${htmlSizeKB} KB of HTML structure...`);

          const duration = Date.now() - startTime;
          log.info('Playwright capture complete', {
            durationMs: duration,
            htmlSizeKb: parseFloat(htmlSizeKB),
            a11yElements: stats.total,
            links: stats.links,
            buttons: stats.buttons,
            images: stats.images,
          });
          return {
            title,
            screenshotBuffer, // Raw buffer for direct S3 upload (full page)
            screenshotTiles, // Tiles for LLM analysis (split if page exceeds provider limits)
            accessibilityTree: snapshot,
            html,
            finalUrl: page.url(),
          };
        })(),
        operationPromise,
      ]);

      // A redirect-hop violation kills the page mid-capture; if the capture somehow
      // completed anyway, discard the results rather than feed them to the LLM. Awaits any
      // in-flight redirect validations so a fast internal redirect can't beat its verdict.
      await requestGuard.assertNoViolation();

      return result;
    } catch (error) {
      // A blocked navigation surfaces from Playwright as an opaque net::ERR_BLOCKED_BY_CLIENT
      // (or "page closed" when the redirect guard killed the page) - rethrow it as a
      // BlockedRequestError that names the offending URL instead.
      await requestGuard.assertNoViolation();

      log.error('Playwright capture failed', {
        errorName: error instanceof Error ? error.name : 'Unknown',
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      // CRITICAL: Always clear timeout and cleanup resources
      if (timeoutId) clearTimeout(timeoutId);

      // Close page and context to free memory
      try {
        await page.close();
      } catch (e) {
        log.warn('Error closing page', {
          errorMessage: e instanceof Error ? e.message : String(e),
        });
      }

      try {
        await context.close();
      } catch (e) {
        log.warn('Error closing context', {
          errorMessage: e instanceof Error ? e.message : String(e),
        });
      }

      // Release concurrency slot
      this.releaseSlot();

      // Log memory usage for monitoring
      const memUsage = process.memoryUsage();
      log.info('Memory after cleanup', {
        heapUsedMb: Math.round(memUsage.heapUsed / 1024 / 1024),
        rssMb: Math.round(memUsage.rss / 1024 / 1024),
      });
    }
  }

  /**
   * Re-open a page to resolve CSS selectors to pixel bounding boxes.
   * Lightweight operation: no screenshot, no a11y tree, no CDP session.
   * Uses the existing browser server to avoid launch overhead.
   */
  async resolveElementBoundingBoxes(
    url: string,
    selectors: string[],
    customHeaders?: ScanHeader[],
    jobLogger?: Logger,
  ): Promise<Map<string, { x: number; y: number; width: number; height: number }>> {
    const log = jobLogger || defaultLogger;
    const results = new Map<string, { x: number; y: number; width: number; height: number }>();

    if (!selectors.length || !this.browser) {
      return results;
    }

    const startTime = Date.now();
    log.info('Resolving element bounding boxes', { selectorCount: selectors.length });

    // Build extra HTTP headers (reuse same headers as original capture)
    const extraHTTPHeaders: Record<string, string> = {
      'Accept-Language': 'en-US,en;q=0.9',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Sec-Ch-Ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"Windows"',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1',
    };

    if (customHeaders) {
      for (const header of customHeaders) {
        if (header.type === 'header') {
          extraHTTPHeaders[header.key] = header.value;
        } else if (header.type === 'authorization') {
          extraHTTPHeaders['Authorization'] = `Bearer ${header.value}`;
        }
      }
    }

    const context = await this.browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
      locale: 'en-US',
      timezoneId: 'America/New_York',
      extraHTTPHeaders,
      // Same SSRF posture as the capture context (security audit H-1)
      serviceWorkers: 'block',
    });

    // Apply cookies if present
    if (customHeaders) {
      const cookies = customHeaders
        .filter((h) => h.type === 'cookie')
        .map((h) => ({ name: h.key, value: h.value, url }));
      if (cookies.length > 0) {
        await context.addCookies(cookies);
      }
    }

    const page = await context.newPage();

    // SSRF guard (security audit H-1): this method re-navigates a user-controlled URL,
    // so it needs the same request validation as the main capture. A violation closes
    // the page; the resulting error is swallowed by the catch below (annotation is
    // non-blocking) and the scan continues without bounding boxes.
    await installRequestGuard(context, page, log, { allowPrivateNetworks: this.allowPrivateNetworks });

    try {
      // Navigate with a shorter timeout since we just need the DOM
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      // Brief wait for rendering
      await page.waitForTimeout(2000);

      // Scroll through the page to trigger lazy loading (matches original screenshot capture)
      // Uses string-based evaluate to avoid TS DOM type errors in Node context
      await page.evaluate(`(async () => {
        const scrollHeight = document.body.scrollHeight;
        const viewportHeight = window.innerHeight;
        if (scrollHeight > viewportHeight * 1.5) {
          const steps = Math.min(Math.ceil(scrollHeight / viewportHeight), 10);
          for (let i = 1; i <= steps; i++) {
            window.scrollTo({ top: (scrollHeight * i) / steps });
            await new Promise(r => setTimeout(r, 150));
          }
          window.scrollTo({ top: 0 });
          await new Promise(r => setTimeout(r, 300));
        }
      })()`);

      // Resolve each selector with individual timeouts
      for (const selector of selectors) {
        // Skip already-elapsed time check
        if (Date.now() - startTime > 15000) {
          log.debug('Bounding box resolution time limit reached', { resolved: results.size });
          break;
        }

        try {
          const bbox = await page.locator(selector).first().boundingBox({ timeout: 500 });
          if (bbox && bbox.width > 0 && bbox.height > 0) {
            results.set(selector, { x: bbox.x, y: bbox.y, width: bbox.width, height: bbox.height });
          }
        } catch {
          // Selector not found or timed out - skip silently
        }
      }

      log.info('Bounding box resolution complete', {
        resolved: results.size,
        total: selectors.length,
        durationMs: Date.now() - startTime,
      });
    } catch (error) {
      log.warn('Bounding box resolution failed', {
        errorMessage: error instanceof Error ? error.message : String(error),
        resolved: results.size,
      });
    } finally {
      try {
        await page.close();
      } catch {
        /* ignore */
      }
      try {
        await context.close();
      } catch {
        /* ignore */
      }
    }

    return results;
  }
}

// Export a singleton instance
export const playwrightService = new PlaywrightService();
