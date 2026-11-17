import { describe, expect, it } from 'vitest';
import { formatCardNumber } from '../src/features/checkout/card-number';

describe('formatCardNumber', () => {
  it('groups digits in fours, without a trailing space', () => {
    expect(formatCardNumber('4111111111111111')).toBe('4111 1111 1111 1111');
    expect(formatCardNumber('5105-1051-0510-5100')).toBe('5105 1051 0510 5100');
    expect(formatCardNumber('4111')).toBe('4111');
    expect(formatCardNumber('41111')).toBe('4111 1');
    expect(formatCardNumber('')).toBe('');
  });

  it('groups American Express as 4-6-5 and cuts it at 15 digits', () => {
    expect(formatCardNumber('378282246310005')).toBe('3782 822463 10005');
    expect(formatCardNumber('3782')).toBe('3782');
    expect(formatCardNumber('37828')).toBe('3782 8');
    expect(formatCardNumber('3782 8224 6310 0059 999')).toBe('3782 822463 10005');
  });
});
