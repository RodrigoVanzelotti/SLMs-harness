import { describe, expect, it } from 'vitest';
import { priceParam } from '../src/features/browse/browse-params';

describe('priceParam', () => {
  it('writes min-max in minor units, leaving max empty when open-ended', () => {
    expect(priceParam({ min: 0, max: 5000 })).toBe('0-5000');
    expect(priceParam({ min: 5000, max: 10000 })).toBe('5000-10000');
    expect(priceParam({ min: 200000, max: null })).toBe('200000-');
  });
});
