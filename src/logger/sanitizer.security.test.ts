/**
 * Security regression tests for log sanitizing: URLs reach the logs whole (scan targets,
 * blocked requests), so their credentials are masked like any other secret.
 */
import { describe, expect, it } from 'vitest';

import { getMaskPlaceholder, sanitize, sanitizeString } from './sanitizer.js';

const MASK = getMaskPlaceholder();

describe('URL credentials in logs', () => {
  it('masks userinfo', () => {
    expect(sanitizeString('https://alice:hunter2@app.example.com/dashboard')).toBe(
      `https://${MASK}@app.example.com/dashboard`,
    );
    expect(sanitizeString('Blocked https://ghp_abc123@example.com/x')).toBe(`Blocked https://${MASK}@example.com/x`);
  });

  it('masks token-like query values and keeps the rest', () => {
    expect(
      sanitizeString('https://example.com/a?page=2&token=abc&access_token=def&X-Amz-Signature=0f&sig=s&code=c&q=x'),
    ).toBe(
      `https://example.com/a?page=2&token=${MASK}&access_token=${MASK}&X-Amz-Signature=${MASK}&sig=${MASK}&code=${MASK}&q=x`,
    );
  });

  it('masks api keys, secrets, passwords, and session ids in query strings', () => {
    const out = sanitizeString(
      'http://example.com/?api_key=k1&apiKey=k2&key=k3&client_secret=s&password=p&PHPSESSID=x&author=me#frag',
    );
    expect(out).toBe(
      `http://example.com/?api_key=${MASK}&apiKey=${MASK}&key=${MASK}&client_secret=${MASK}&password=${MASK}&PHPSESSID=${MASK}&author=me#frag`,
    );
  });

  it('masks URLs inside log context fields', () => {
    expect(sanitize({ url: 'https://u:p@example.com/?token=t', blockedUrl: 'wss://example.com/?auth=a' })).toEqual({
      url: `https://${MASK}@example.com/?token=${MASK}`,
      blockedUrl: `wss://example.com/?auth=${MASK}`,
    });
  });

  it('masks userinfo that contains an apostrophe or a raw @', () => {
    expect(sanitizeString("https://alice:p'ass@example.com/")).toBe(`https://${MASK}@example.com/`);
    expect(sanitizeString('https://alice:p@ss@example.com/')).toBe(`https://${MASK}@example.com/`);
  });

  it('matches percent-encoded and bracketed parameter names', () => {
    expect(sanitizeString('https://example.com/?to%6ben=secret-value&tags[]=a')).toBe(
      `https://example.com/?to%6ben=${MASK}&tags[]=a`,
    );
    expect(sanitizeString('https://example.com/?user[password]=p&token[]=t')).toBe(
      `https://example.com/?user[password]=${MASK}&token[]=${MASK}`,
    );
    // A malformed escape must not throw.
    expect(sanitizeString('https://example.com/?%E0%A4%A=1&token=t')).toBe(
      `https://example.com/?%E0%A4%A=1&token=${MASK}`,
    );
  });

  it('masks token-like values in the fragment', () => {
    expect(sanitizeString('https://app.example.com/cb#access_token=abc&token_type=bearer&state=s')).toBe(
      `https://app.example.com/cb#access_token=${MASK}&token_type=bearer&state=s`,
    );
  });

  it('leaves URLs without credentials unchanged', () => {
    const url = 'https://example.com/products;color=red?page=2&sort=asc#top';
    expect(sanitizeString(url)).toBe(url);
  });

  it('stays linear on long URL-free input', () => {
    const input = `${'a'.repeat(200_000)} ${'http'.repeat(50_000)}`;
    const start = Date.now();
    sanitizeString(input);
    expect(Date.now() - start).toBeLessThan(1000);
  });
});
