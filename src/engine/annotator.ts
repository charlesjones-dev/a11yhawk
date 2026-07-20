/**
 * Screenshot Annotation Module
 *
 * Draws colored bounding boxes on screenshots to highlight accessibility issues.
 * Uses Sharp SVG compositing for server-side annotation.
 *
 * Resolution strategy:
 * 1. Extract CSS selectors from LLM `location` field (parenthesized selectors)
 * 2. Derive selectors from `codeContext` HTML snippets (id, class attributes)
 * 3. Resolve all selectors via Playwright (same browser/viewport as screenshot)
 */
import sharp from 'sharp';
import type { Logger } from '../logger/index.js';
import type { AccessibilityIssue, ScanHeader } from '../types.js';
import type { PlaywrightService } from './playwright.js';

// Severity color palette
const SEVERITY_COLORS = {
  critical: { fill: 'rgba(239, 68, 68, 0.15)', stroke: '#EF4444' },
  high: { fill: 'rgba(249, 115, 22, 0.15)', stroke: '#F97316' },
  medium: { fill: 'rgba(234, 179, 8, 0.15)', stroke: '#EAB308' },
  low: { fill: 'rgba(59, 130, 246, 0.15)', stroke: '#3B82F6' },
} satisfies Record<string, { fill: string; stroke: string }>;

const SEVERITY_ORDER: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 };

type BBox = { x: number; y: number; width: number; height: number };

interface AnnotationTarget {
  issueId: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  bbox: BBox;
}

export interface AnnotationResult {
  annotatedBuffer: Buffer | null;
  annotationCount: number;
  unresolvedCount: number;
  durationMs: number;
}

interface AnnotateScreenshotParams {
  screenshotBuffer: Buffer;
  issues: AccessibilityIssue[];
  url: string;
  playwrightService: PlaywrightService;
  customHeaders?: ScanHeader[];
  jobLogger?: Logger;
}

/**
 * Extract CSS selectors from an issue's location field.
 *
 * LLM location format: "Hero image (.hero-banner img), product thumbnails (#products .product-img)"
 * Each comma-separated segment may have a parenthesized CSS selector.
 */
export function extractSelectorsFromLocation(location: string): string[] {
  if (!location) return [];

  const selectors: string[] = [];

  // Extract ALL parenthesized selectors: "desc (sel1), desc (sel2)" -> [sel1, sel2]
  const parenMatches = location.matchAll(/\(([^)]+)\)/g);
  for (const match of parenMatches) {
    const inner = match[1]?.trim() ?? '';
    if (looksLikeSelector(inner)) {
      selectors.push(inner);
    }
  }

  if (selectors.length > 0) return selectors;

  // Fallback: try the whole string or comma-separated parts as raw selectors
  const parts = location.split(/,\s*(?![^[\]]*\])/);
  for (const part of parts) {
    const trimmed = part.trim();
    if (looksLikeSelector(trimmed)) {
      selectors.push(trimmed);
    }
  }

  if (selectors.length > 0) return selectors;

  // Last resort: derive semantic HTML5 element selectors from description text
  const semantic = deriveSemanticSelectors(location);
  selectors.push(...semantic);

  return selectors;
}

/**
 * Semantic HTML5 keyword -> selector mapping.
 * Used when the location field contains a description rather than a CSS selector.
 */
const SEMANTIC_KEYWORDS: [RegExp, string][] = [
  [/\bnav(igation)?\b/i, 'nav'],
  [/\bfooter\b/i, 'footer'],
  [/\bheader\b|\bbanner\b/i, 'header'],
  [/\bmain\s*content\b/i, 'main'],
  [/\bform\b/i, 'form'],
  [/\bsearch\b/i, '[role="search"], form[role="search"]'],
  [/\btable\b/i, 'table'],
  [/\bimage|img\b/i, 'img'],
  [/\bbutton\b/i, 'button'],
  [/\blink\b|\banchor\b/i, 'a'],
  [/\binput\b|\btext\s*field\b/i, 'input'],
  [/\bvideo\b/i, 'video'],
  [/\biframe\b/i, 'iframe'],
  [/\bskip\b.*\blink\b/i, 'a[href="#main"], a[href="#content"], a.skip-link, .skip-nav a, [class*="skip"]'],
];

function deriveSemanticSelectors(description: string): string[] {
  const selectors: string[] = [];
  for (const [pattern, selector] of SEMANTIC_KEYWORDS) {
    if (pattern.test(description)) {
      // Some entries contain comma-separated selectors; split them
      for (const s of selector.split(/,\s*/)) {
        selectors.push(s.trim());
      }
      break; // Use the first semantic match only
    }
  }
  return selectors;
}

/**
 * Extract CSS selectors from an HTML snippet in codeContext.
 *
 * Strategies (in priority order):
 * 1. id attributes -> "#id"
 * 2. tag.class selectors -> "img.hero-banner"
 * 3. ARIA/role attributes -> '[aria-label="..."]', '[role="..."]'
 * 4. Distinctive attributes -> 'img[src="/logo.png"]'
 * 5. Text content -> 'a:has-text("About")' (Playwright-specific)
 */
export function extractSelectorsFromCodeContext(codeContext: string | null): string[] {
  if (!codeContext) return [];
  // Skip N/A codeContext values
  if (codeContext.startsWith('N/A')) return [];

  const selectors: string[] = [];
  // Match opening HTML tags with their attributes, and capture text content after the tag
  const tagWithContentPattern = /<(\w+)(\s+[^>]*?)?>([^<]*)/g;

  for (const match of codeContext.matchAll(tagWithContentPattern)) {
    const tag = match[1]?.toLowerCase() ?? '';
    const attrs = match[2]?.trim() || '';
    const textContent = match[3]?.trim() || '';

    // Skip non-element tags
    if (['script', 'style', 'head', 'html', 'body'].includes(tag)) continue;

    // 1. id-based selectors (most specific, always use)
    const idMatch = attrs.match(/id=["']([^"']+)["']/);
    if (idMatch) {
      selectors.push(`#${idMatch[1]}`);
      continue;
    }

    // Skip generic wrapper tags (unless they have id, handled above)
    if (['div', 'span', 'section', 'main'].includes(tag)) {
      // Still try ARIA attributes on generic tags
      const ariaLabel = attrs.match(/aria-label=["']([^"']+)["']/);
      if (ariaLabel) {
        selectors.push(`[aria-label="${ariaLabel[1]}"]`);
      }
      const role = attrs.match(/role=["']([^"']+)["']/);
      if (role) {
        selectors.push(`[role="${role[1]}"]`);
      }
      continue;
    }

    // 2. tag.class selector
    const classMatch = attrs.match(/class=["']([^"']+)["']/);
    if (classMatch) {
      const firstClass = classMatch[1]?.split(/\s+/)[0];
      if (firstClass) {
        selectors.push(`${tag}.${firstClass}`);
      }
      continue;
    }

    // 3. ARIA/role attribute selectors
    const ariaLabel = attrs.match(/aria-label=["']([^"']+)["']/);
    if (ariaLabel) {
      selectors.push(`${tag}[aria-label="${ariaLabel[1]}"]`);
      continue;
    }

    const role = attrs.match(/role=["']([^"']+)["']/);
    if (role) {
      selectors.push(`${tag}[role="${role[1]}"]`);
      continue;
    }

    // 4. Distinctive attributes (src, href, name, type)
    const srcMatch = attrs.match(/(?:src|href)=["']([^"']+)["']/);
    if (srcMatch) {
      const attrName = attrs.match(/src=/) ? 'src' : 'href';
      selectors.push(`${tag}[${attrName}="${srcMatch[1]}"]`);
      continue;
    }

    const nameMatch = attrs.match(/name=["']([^"']+)["']/);
    if (nameMatch) {
      selectors.push(`${tag}[name="${nameMatch[1]}"]`);
      continue;
    }

    // 5. Text content for interactive elements (Playwright :has-text selector)
    if (textContent && textContent.length >= 2 && textContent.length <= 60) {
      if (['a', 'button', 'label', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tag)) {
        selectors.push(`${tag}:has-text("${textContent}")`);
      }
    }
  }

  // Deduplicate and limit
  return [...new Set(selectors)].slice(0, 8);
}

/**
 * Simple heuristic: does this string look like a CSS selector?
 */
function looksLikeSelector(s: string): boolean {
  if (!s || s.length > 200) return false;
  // Must start with a selector-like character
  return /^[.#[:a-zA-Z]/.test(s) && !/\s{3,}/.test(s) && !/^[A-Z][a-z]+\s/.test(s);
}

/**
 * Build an SVG overlay with colored bounding boxes for each annotation target.
 */
export function buildAnnotationSVG(width: number, height: number, targets: AnnotationTarget[]): string {
  if (!targets.length) return '';

  // Sort: low severity first so critical paints on top
  const sorted = [...targets].sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 0) - (SEVERITY_ORDER[b.severity] ?? 0));

  let rects = '';
  for (const target of sorted) {
    const colors = SEVERITY_COLORS[target.severity] ?? SEVERITY_COLORS.medium;
    // Enforce minimum size for visibility
    const bw = Math.max(target.bbox.width, 20);
    const bh = Math.max(target.bbox.height, 20);
    const bx = Math.max(0, target.bbox.x);
    const by = Math.max(0, target.bbox.y);

    // Semi-transparent fill + solid border
    rects += `<rect x="${bx}" y="${by}" width="${bw}" height="${bh}" fill="${colors.fill}" stroke="${colors.stroke}" stroke-width="3" rx="2"/>`;

    // Issue ID label pill
    const labelText = target.issueId;
    const labelWidth = labelText.length * 7 + 12;
    const labelHeight = 18;
    // Clamp label position within image bounds
    const labelX = Math.min(bx, width - labelWidth - 2);
    const labelY = Math.max(0, by - labelHeight - 2);

    rects += `<rect x="${labelX}" y="${labelY}" width="${labelWidth}" height="${labelHeight}" fill="${colors.stroke}" rx="3"/>`;
    rects += `<text x="${labelX + 6}" y="${labelY + 13}" fill="white" font-family="monospace" font-size="11" font-weight="bold">${escapeXml(labelText)}</text>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${rects}</svg>`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Main annotation function. Extracts CSS selectors from each issue's location
 * and codeContext, resolves them to bounding boxes via Playwright (same viewport
 * as the screenshot), then composites colored overlays onto the screenshot.
 */
export async function annotateScreenshot(params: AnnotateScreenshotParams): Promise<AnnotationResult> {
  const { screenshotBuffer, issues, url, playwrightService, customHeaders, jobLogger: log } = params;
  const startTime = Date.now();

  // Get screenshot dimensions
  const metadata = await sharp(screenshotBuffer).metadata();
  const imgWidth = metadata.width || 1920;
  const imgHeight = metadata.height || 1080;

  // Collect selectors for every issue
  const issueSelectors: Map<string, string[]> = new Map();

  for (const issue of issues) {
    const selectors = [
      ...extractSelectorsFromLocation(issue.location),
      ...extractSelectorsFromCodeContext(issue.codeContext),
    ];

    if (selectors.length > 0) {
      issueSelectors.set(issue.id, selectors);
    }
  }

  const targets: AnnotationTarget[] = [];
  const resolvedIssueIds = new Set<string>();

  // Resolve all selectors via Playwright (same browser/viewport as screenshot)
  if (issueSelectors.size > 0) {
    try {
      const allSelectors = [...new Set([...issueSelectors.values()].flat())];

      log?.debug('Annotation: resolving selectors via Playwright', {
        issuesWithSelectors: issueSelectors.size,
        uniqueSelectors: allSelectors.length,
      });

      const playwrightBboxes = await playwrightService.resolveElementBoundingBoxes(
        url,
        allSelectors,
        customHeaders,
        log,
      );

      // Match resolved bboxes back to issues
      for (const [issueId, selectors] of issueSelectors) {
        for (const selector of selectors) {
          const bbox = playwrightBboxes.get(selector);
          if (bbox) {
            const issue = issues.find((i) => i.id === issueId);
            if (issue) {
              targets.push({ issueId: issue.id, severity: issue.severity, bbox });
              resolvedIssueIds.add(issue.id);
            }
            break;
          }
        }
      }
    } catch (error) {
      log?.warn('Playwright bounding box resolution failed during annotation', {
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const unresolvedCount = issues.length - resolvedIssueIds.size;

  log?.info('Annotation resolution complete', {
    annotationCount: targets.length,
    unresolvedCount,
    total: issues.length,
  });

  // If no targets resolved, skip compositing
  if (targets.length === 0) {
    return {
      annotatedBuffer: null,
      annotationCount: 0,
      unresolvedCount,
      durationMs: Date.now() - startTime,
    };
  }

  // Build SVG overlay and composite onto screenshot
  const svg = buildAnnotationSVG(imgWidth, imgHeight, targets);
  const svgBuffer = Buffer.from(svg);

  const annotatedBuffer = await sharp(screenshotBuffer)
    .composite([{ input: svgBuffer, blend: 'over' }])
    .jpeg({ quality: 60 })
    .toBuffer();

  return {
    annotatedBuffer,
    annotationCount: targets.length,
    unresolvedCount,
    durationMs: Date.now() - startTime,
  };
}
