import { describe, expect, it } from 'vitest';
import { cardDigits } from '../src/features/checkout/card-number';

describe('cardDigits', () => {
  it('keeps only the digits', () => {
    expect(cardDigits('4111 1111-1111.1111')).toBe('4111111111111111');
    expect(cardDigits('abc')).toBe('');
    expect(cardDigits('')).toBe('');
  });

  it('keeps at most 19 digits', () => {
    expect(cardDigits('1234 5678 9012 3456 7890 123')).toBe('1234567890123456789');
  });
});
