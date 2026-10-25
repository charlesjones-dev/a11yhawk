import { chromium } from 'playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ANTHROPIC_TILE_DIMENSION, getMaxImageDimension, PlaywrightService } from './playwright.js';

describe('getMaxImageDimension', () => {
  it('gives the Anthropic provider its own tile size whatever the model id looks like', () => {
    expect(getMaxImageDimension('claude-opus-5-5', 'anthropic')).toBe(ANTHROPIC_TILE_DIMENSION);
    expect(getMaxImageDimension('anthropic/claude-sonnet-5', 'anthropic')).toBe(ANTHROPIC_TILE_DIMENSION);
    expect(getMaxImageDimension('openai/gpt-x', 'anthropic')).toBe(ANTHROPIC_TILE_DIMENSION);
  });

  it('keeps the OpenRouter lookup keyed by the model id prefix', () => {
    expect(getMaxImageDimension('anthropic/claude-sonnet-5')).toBe(8000);
    expect(getMaxImageDimension('anthropic/claude-sonnet-5', 'openrouter')).toBe(8000);
    expect(getMaxImageDimension('google/gemini-x', 'openrouter')).toBe(3072);
    expect(getMaxImageDimension('claude-opus-5-5')).toBe(2048);
  });

  it('sizes Anthropic tiles to avoid downscaling and to fit requests with more than 20 images', () => {
    // A full tile from the 1920 px viewport, or a wider page scaled down to the tile size.
    for (const width of [1920, ANTHROPIC_TILE_DIMENSION]) {
      const visualTokens = Math.ceil(width / 28) * Math.ceil(ANTHROPIC_TILE_DIMENSION / 28);
      expect(visualTokens).toBeLessThanOrEqual(4784);
    }
    expect(ANTHROPIC_TILE_DIMENSION).toBeLessThanOrEqual(2576);
    expect(ANTHROPIC_TILE_DIMENSION).toBeLessThanOrEqual(2000);
  });
});

describe('PlaywrightService Chromium sandbox', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Playwright adds --no-sandbox unless chromiumSandbox is true, so the sandbox is on only
  // when the launch asks for it. The launch is stubbed: no browser starts.
  async function launchOptions(options: ConstructorParameters<typeof PlaywrightService>[0]) {
    const launchServer = vi.spyOn(chromium, 'launchServer').mockRejectedValue(new Error('stubbed launch'));
    await expect(new PlaywrightService(options).initialize()).rejects.toThrow('stubbed launch');
    expect(launchServer).toHaveBeenCalledTimes(1);
    return launchServer.mock.calls[0]?.[0];
  }

  it('asks for the sandbox by default', async () => {
    const options = await launchOptions({});
    expect(options?.chromiumSandbox).toBe(true);
    expect(options?.args).not.toContain('--no-sandbox');
  });

  it('turns the sandbox off only with disableSandbox', async () => {
    const options = await launchOptions({ disableSandbox: true });
    expect(options?.chromiumSandbox).toBe(false);
    expect(options?.args).toContain('--no-sandbox');
  });
});
