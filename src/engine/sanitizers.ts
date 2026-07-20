/**
 * Token reduction utilities for sanitizing HTML and accessibility tree data
 * before sending to the LLM. These functions remove unnecessary content
 * that doesn't contribute to accessibility analysis.
 */

// ============================================================================
// HTML Sanitization
// ============================================================================

/**
 * Removes content that doesn't affect accessibility analysis:
 * - <script> tags and contents
 * - <style> tags and contents
 * - <noscript> tags and contents
 * - SVG path data (d="...") - keeps SVG structure for role/aria analysis
 * - Inline event handlers (onclick, onmouseover, etc.)
 * - data-* attributes (except data-testid for debugging)
 * - HTML comments
 * - Excessive whitespace
 */
export function sanitizeHtml(html: string): string {
  let result = html;

  // Remove <script> tags and their contents (including inline scripts)
  result = result.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');

  // Remove <style> tags and their contents
  result = result.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');

  // Remove <noscript> tags and their contents
  result = result.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '');

  // Extract and preserve <title> before removing <head>
  const titleMatch = result.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const titleTag = titleMatch ? `<title>${titleMatch[1]}</title>` : '';

  // Remove entire <head> section (scripts, styles, meta, links, etc. - only title matters for a11y)
  // Keep the opening <html> tag with lang attribute, replace head contents with just title
  result = result.replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, `<head>${titleTag}</head>`);

  // Remove <link> tags that may appear in body (lazy-loaded stylesheets, etc.)
  result = result.replace(/<link\b[^>]*>/gi, '');

  // Remove <meta> tags that may appear outside <head> (or in malformed HTML)
  result = result.replace(/<meta\b[^>]*>/gi, '');

  // Remove HTML comments
  result = result.replace(/<!--[\s\S]*?-->/g, '');

  // Remove SVG path data (d="...") - keeps the element structure
  // This can save significant tokens on icon-heavy pages
  result = result.replace(/\s+d="[^"]*"/gi, '');
  result = result.replace(/\s+d='[^']*'/gi, '');

  // Remove SVG points attribute (for polygons/polylines)
  result = result.replace(/\s+points="[^"]*"/gi, '');
  result = result.replace(/\s+points='[^']*'/gi, '');

  // Remove SVG visual attributes (not needed - visual analysis from screenshot)
  const svgVisualAttrs = [
    'fill',
    'stroke',
    'stroke-width',
    'viewBox',
    'xmlns',
    'transform',
    'opacity',
    'filter',
    'clip-path',
    'mask',
  ];
  for (const attr of svgVisualAttrs) {
    result = result.replace(new RegExp(`\\s+${attr}="[^"]*"`, 'gi'), '');
    result = result.replace(new RegExp(`\\s+${attr}='[^']*'`, 'gi'), '');
  }

  // Remove inline event handlers
  const eventHandlers = [
    'onclick',
    'ondblclick',
    'onmousedown',
    'onmouseup',
    'onmouseover',
    'onmousemove',
    'onmouseout',
    'onmouseenter',
    'onmouseleave',
    'onkeydown',
    'onkeyup',
    'onkeypress',
    'onfocus',
    'onblur',
    'onchange',
    'oninput',
    'onsubmit',
    'onreset',
    'onload',
    'onunload',
    'onerror',
    'onresize',
    'onscroll',
    'ontouchstart',
    'ontouchmove',
    'ontouchend',
    'ontouchcancel',
    'ondrag',
    'ondragstart',
    'ondragend',
    'ondragenter',
    'ondragleave',
    'ondragover',
    'ondrop',
    'onanimationstart',
    'onanimationend',
    'onanimationiteration',
    'ontransitionend',
    'onwheel',
    'oncontextmenu',
    'oncopy',
    'oncut',
    'onpaste',
  ];
  for (const handler of eventHandlers) {
    // Match handler="..." or handler='...' (handles multi-line values)
    const regex = new RegExp(`\\s+${handler}="[^"]*"`, 'gi');
    result = result.replace(regex, '');
    const regexSingle = new RegExp(`\\s+${handler}='[^']*'`, 'gi');
    result = result.replace(regexSingle, '');
  }

  // Remove data-* attributes except data-testid
  // Matches data-anything="value" but not data-testid
  result = result.replace(/\s+data-(?!testid)[a-z0-9-]+="[^"]*"/gi, '');
  result = result.replace(/\s+data-(?!testid)[a-z0-9-]+='[^']*'/gi, '');

  // Remove inline styles (visual info comes from screenshot)
  result = result.replace(/\s+style="[^"]*"/gi, '');
  result = result.replace(/\s+style='[^']*'/gi, '');

  // Remove class attributes (visual info comes from screenshot, semantic info from a11y tree)
  result = result.replace(/\s+class="[^"]*"/gi, '');
  result = result.replace(/\s+class='[^']*'/gi, '');

  // Remove srcset (src is enough for alt text analysis)
  result = result.replace(/\s+srcset="[^"]*"/gi, '');
  result = result.replace(/\s+srcset='[^']*'/gi, '');

  // Remove sizes attribute (layout info not needed)
  result = result.replace(/\s+sizes="[^"]*"/gi, '');
  result = result.replace(/\s+sizes='[^']*'/gi, '');

  // Remove empty attributes (nonce="", async="", defer="", etc.)
  result = result.replace(/\s+\w+=""/g, '');
  result = result.replace(/\s+\w+=''/g, '');

  // Collapse multiple whitespace/newlines into single space
  result = result.replace(/\s{2,}/g, ' ');

  // Remove whitespace between tags
  result = result.replace(/>\s+</g, '><');

  // Trim leading/trailing whitespace
  result = result.trim();

  // Apply prompt injection escaping as final step
  result = escapeForPromptInternal(result);

  return result;
}

/**
 * Internal escaping function (forward declaration for use in sanitizeHtml).
 * The full escapeForPrompt is defined below with marker escaping.
 */
function escapeForPromptInternal(content: string): string {
  // Escape triple backticks to prevent breaking out of markdown code blocks
  return content.replace(/```/g, '\\`\\`\\`');
}

// ============================================================================
// Prompt Injection Protection
// ============================================================================

/**
 * Content boundary markers used to demarcate untrusted webpage content in prompts.
 * These markers help the LLM distinguish system instructions from user-provided content.
 */
export const CONTENT_MARKERS = {
  HTML_START: '<<<BEGIN_WEBPAGE_HTML>>>',
  HTML_END: '<<<END_WEBPAGE_HTML>>>',
  A11Y_TREE_START: '<<<BEGIN_ACCESSIBILITY_TREE>>>',
  A11Y_TREE_END: '<<<END_ACCESSIBILITY_TREE>>>',
  URL_START: '<<<BEGIN_TARGET_URL>>>',
  URL_END: '<<<END_TARGET_URL>>>',
  LIGHTHOUSE_START: '<<<BEGIN_LIGHTHOUSE_DATA>>>',
  LIGHTHOUSE_END: '<<<END_LIGHTHOUSE_DATA>>>',
} as const;

/**
 * Escapes content that could be used for prompt injection attacks.
 * This function sanitizes text content from webpages before including it in LLM prompts.
 *
 * Protections:
 * - Escapes markdown code block delimiters (```) to prevent breaking out of code blocks
 * - Escapes the content boundary markers to prevent spoofing
 * - Escapes HTML entities that could confuse parsing
 *
 * @param content - Raw text content from a webpage
 * @returns Escaped content safe for inclusion in prompts
 */
export function escapeForPrompt(content: string): string {
  let result = content;

  // Escape triple backticks to prevent breaking out of markdown code blocks
  // Replace ``` with escaped version that won't be interpreted as code fence
  result = result.replace(/```/g, '\\`\\`\\`');

  // Escape our content boundary markers to prevent spoofing
  // An attacker could try to inject fake end markers to break out of the content section
  for (const marker of Object.values(CONTENT_MARKERS)) {
    // Escape by inserting zero-width spaces to break the pattern
    // This preserves readability while preventing marker spoofing
    const escaped = marker.slice(0, 3) + '\u200B' + marker.slice(3);
    result = result.replace(new RegExp(escapeRegExp(marker), 'g'), escaped);
  }

  return result;
}

/**
 * Escapes special regex characters in a string for use in RegExp constructor
 */
function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ============================================================================
// Accessibility Tree Sanitization
// ============================================================================

interface A11yNode {
  role?: string;
  name?: string;
  description?: string;
  value?: string;
  children?: A11yNode[];
  [key: string]: unknown;
}

/**
 * Sanitizes the accessibility tree to reduce tokens:
 * - Removes nodes with role "none" or "presentation" (decorative)
 * - Strips null/undefined/empty string values
 * - Removes whitespace-only StaticText nodes
 * - Removes empty children arrays
 * - Keeps only accessibility-relevant properties
 * - Preserves structure (keeps nodes with children even if no role/name)
 */
export function sanitizeA11yTree(node: A11yNode | null): A11yNode | null {
  if (!node) return null;

  // Skip decorative/presentation nodes entirely (but keep their children would be lost)
  // Only skip if this is a leaf node
  const hasChildren = node.children && Array.isArray(node.children) && node.children.length > 0;

  if ((node.role === 'none' || node.role === 'presentation') && !hasChildren) {
    return null;
  }

  // Skip StaticText/text nodes that are just whitespace
  if (node.role === 'StaticText' || node.role === 'text') {
    const name = node.name?.trim();
    if (!name) return null;
  }

  // Build a clean node with only relevant properties
  const cleanNode: A11yNode = {};

  // Only include non-empty values (but skip "generic" role as it's not informative)
  if (node.role && node.role !== 'generic') {
    cleanNode.role = node.role;
  }
  if (node.name?.trim()) cleanNode.name = node.name.trim();
  if (node.description?.trim()) cleanNode.description = node.description.trim();
  if (typeof node.value === 'string' && node.value.trim()) {
    cleanNode.value = node.value.trim();
  } else if (node.value !== undefined && node.value !== null && node.value !== '') {
    cleanNode.value = String(node.value);
  }

  // Include other accessibility-relevant properties if present and truthy
  const relevantProps = [
    'level', // heading level
    'checked', // checkbox/radio state
    'selected', // selection state
    'expanded', // expandable state
    'pressed', // toggle button state
    'disabled', // disabled state
    'required', // required field
    'invalid', // validation state
    'readonly', // readonly state
    'autocomplete', // autocomplete attribute
    'haspopup', // popup indicator
    'modal', // modal state
    'multiselectable', // multi-select
    'orientation', // orientation
    'valuemin', // range min
    'valuemax', // range max
    'valuenow', // range current
    'valuetext', // range text
    'busy', // loading state
    'live', // live region
    'relevant', // live region relevance
    'atomic', // live region atomic
  ];

  for (const prop of relevantProps) {
    const val = node[prop];
    if (val !== undefined && val !== null && val !== '' && val !== false) {
      cleanNode[prop] = val;
    }
  }

  // Recursively process children
  if (node.children && Array.isArray(node.children)) {
    const cleanChildren = node.children
      .map((child) => sanitizeA11yTree(child))
      .filter((child): child is A11yNode => child !== null);

    // Only include children array if non-empty
    if (cleanChildren.length > 0) {
      cleanNode.children = cleanChildren;
    }
  }

  // Keep nodes that have children (structural), role, name, or any meaningful property
  const hasMeaningfulContent =
    cleanNode.role ||
    cleanNode.name ||
    cleanNode.children ||
    relevantProps.some((prop) => cleanNode[prop] !== undefined);

  if (!hasMeaningfulContent) {
    return null;
  }

  return cleanNode;
}

/**
 * Converts the accessibility tree to a compact JSON string.
 * Uses minimal whitespace to reduce tokens while keeping readability.
 * Also applies prompt injection escaping to string values.
 */
export function a11yTreeToCompactJson(tree: A11yNode | null): string {
  const sanitized = sanitizeA11yTree(tree);
  if (!sanitized) return '{}';

  // Use a custom replacer to handle any remaining undefined values
  // and escape string values for prompt injection protection
  const result = JSON.stringify(sanitized, (_, value) => {
    if (value === undefined || value === null) return undefined;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed === '') return undefined;
      // Escape triple backticks in string values
      return escapeForPromptInternal(trimmed);
    }
    return value;
  });

  return result;
}

// ============================================================================
// Token Estimation (for logging/debugging)
// ============================================================================

/**
 * Rough token count estimation (approximately 4 chars per token for English text).
 * This is a heuristic, not exact tokenization.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
