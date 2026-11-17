import { describe, expect, it } from 'vitest';
import { passesLuhn } from '../src/features/checkout/card-number';

describe('passesLuhn', () => {
  it('accepts numbers with a valid check digit, ignoring separators', () => {
    expect(passesLuhn('4111 1111 1111 1111')).toBe(true);
    expect(passesLuhn('378282246310005')).toBe(true);
    expect(passesLuhn('5105105105105100')).toBe(true);
    expect(passesLuhn('6062828888666688')).toBe(true);
    expect(passesLuhn('79927398713')).toBe(true);
  });

  it('rejects a wrong check digit', () => {
    expect(passesLuhn('4111111111111112')).toBe(false);
    expect(passesLuhn('5105105105105101')).toBe(false);
  });

  it('rejects an empty number but not zeros', () => {
    expect(passesLuhn('')).toBe(false);
    expect(passesLuhn('abc')).toBe(false);
    expect(passesLuhn('0')).toBe(true);
  });
});
