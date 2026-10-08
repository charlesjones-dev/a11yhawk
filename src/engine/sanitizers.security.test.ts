/**
 * Security regression tests for sanitizeHtml: every pattern must run in linear time,
 * because page.content() is unbounded and page-controlled and sanitizing runs on the
 * host's event loop (in server mode, a slow pass stalls every concurrent job).
 *
 * Each input is sized so the old quadratic patterns took seconds to minutes; linear
 * passes finish in milliseconds, so the budget is generous for slow CI machines.
 */
import { describe, expect, it } from 'vitest';

import { sanitizeHtml } from './sanitizers.js';

const BUDGET_MS = 500;

function timeMs(html: string): number {
  const start = performance.now();
  sanitizeHtml(html);
  return performance.now() - start;
}

describe('sanitizeHtml runs in linear time on hostile input', () => {
  const cases: Array<{ name: string; html: string }> = [
    { name: 'a long whitespace run in a text node', html: `<html><body><p>${' '.repeat(50_000)}x</p></body></html>` },
    {
      // <xmp> content is raw text the DOM serializer never escapes.
      name: 'raw text full of unclosed <script> openers',
      html: `<html><body><xmp>${'<script>'.repeat(80_000)}</xmp></body></html>`,
    },
    {
      name: 'raw text full of unclosed comments',
      html: `<html><body><xmp>${'<!--'.repeat(150_000)}</xmp></body></html>`,
    },
    {
      name: 'raw text full of unclosed <title> openers',
      html: `<html><body><xmp>${'<title>'.repeat(80_000)}</xmp></body></html>`,
    },
    { name: 'a tail of <link openers with no closing >', html: `<p>x</p>${'<link'.repeat(120_000)}` },
  ];

  for (const { name, html } of cases) {
    it(`handles ${name}`, () => {
      expect(timeMs(html)).toBeLessThan(BUDGET_MS);
    });
  }
});

describe('sanitizeHtml output for unterminated constructs', () => {
  it('still strips terminated elements and leaves unterminated ones as they were', () => {
    expect(sanitizeHtml('<p>a</p><script>x()</script><p>b</p>')).toBe('<p>a</p><p>b</p>');
    expect(sanitizeHtml('<p>a</p><!-- open')).toBe('<p>a</p><!-- open');
    expect(sanitizeHtml('<p>a</p><style>p{}')).toBe('<p>a</p><style>p{}');
  });
});
