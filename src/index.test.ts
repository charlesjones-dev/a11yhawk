import { describe, expect, it } from 'vitest';

import { scan } from './index.js';

describe('scan placeholder', () => {
  it('throws an under-development error', () => {
    expect(() => scan()).toThrow(/under active development/);
  });
});
