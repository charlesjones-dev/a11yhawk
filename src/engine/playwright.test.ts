import { describe, expect, it } from 'vitest';

import { ANTHROPIC_TILE_DIMENSION, getMaxImageDimension } from './playwright.js';

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
