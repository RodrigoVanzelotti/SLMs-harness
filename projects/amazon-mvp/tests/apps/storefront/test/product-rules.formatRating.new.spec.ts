import { describe, expect, it } from 'vitest';
import { formatRating } from '../src/features/product/product-rules';

describe('formatRating', () => {
  it('always shows exactly one decimal, with a Brazilian decimal comma', () => {
    expect(formatRating(4.8)).toBe('4,8');
    expect(formatRating(5)).toBe('5,0');
    expect(formatRating(0)).toBe('0,0');
  });

  it('rounds to one decimal and groups thousands with a dot', () => {
    expect(formatRating(4.25)).toBe('4,3');
    expect(formatRating(3.04)).toBe('3,0');
    expect(formatRating(1234.56)).toBe('1.234,6');
  });
});
