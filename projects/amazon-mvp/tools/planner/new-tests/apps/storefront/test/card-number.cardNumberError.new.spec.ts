import { describe, expect, it } from 'vitest';
import { cardNumberError } from '../src/features/checkout/card-number';

const BRAND = 'Bandeira não aceita. Use Visa, Mastercard, Elo, American Express ou Hipercard.';
const INVALID = 'Número de cartão inválido.';

describe('cardNumberError', () => {
  it('accepts valid numbers of the accepted brands', () => {
    expect(cardNumberError('4111 1111 1111 1111')).toBe('');
    expect(cardNumberError('5105105105105100')).toBe('');
    expect(cardNumberError('378282246310005')).toBe('');
    expect(cardNumberError('6062828888666688')).toBe('');
  });

  it('rejects unknown brands first, including an empty number', () => {
    expect(cardNumberError('6011111111111117')).toBe(BRAND);
    expect(cardNumberError('')).toBe(BRAND);
  });

  it('rejects a wrong length or check digit', () => {
    expect(cardNumberError('4111111111111112')).toBe(INVALID);
    expect(cardNumberError('411111111111111')).toBe(INVALID);
    expect(cardNumberError('41111111111111111')).toBe(INVALID);
    expect(cardNumberError('3782822463100050')).toBe(INVALID);
  });
});
