import { describe, expect, it } from 'vitest';
import { detectCardBrand } from '../src/features/checkout/card-number';

describe('detectCardBrand', () => {
  it('recognizes the accepted brands by prefix', () => {
    expect(detectCardBrand('4111 1111 1111 1111')).toBe('VISA');
    expect(detectCardBrand('4242424242424242')).toBe('VISA');
    expect(detectCardBrand('5555555555554444')).toBe('MASTERCARD');
    expect(detectCardBrand('2223003122003222')).toBe('MASTERCARD');
    expect(detectCardBrand('378282246310005')).toBe('AMEX');
    expect(detectCardBrand('371449635398431')).toBe('AMEX');
    expect(detectCardBrand('6062828888666688')).toBe('HIPERCARD');
    expect(detectCardBrand('5066991111111118')).toBe('ELO');
    expect(detectCardBrand('6362970000457013')).toBe('ELO');
  });

  it('checks Hipercard and Elo prefixes before Visa and Mastercard', () => {
    expect(detectCardBrand('3841')).toBe('HIPERCARD');
    expect(detectCardBrand('4011')).toBe('ELO');
    expect(detectCardBrand('509')).toBe('ELO');
  });

  it('returns null for other or missing prefixes', () => {
    expect(detectCardBrand('6011111111111117')).toBeNull();
    expect(detectCardBrand('30569309025904')).toBeNull();
    expect(detectCardBrand('5')).toBeNull();
    expect(detectCardBrand('')).toBeNull();
  });
});
