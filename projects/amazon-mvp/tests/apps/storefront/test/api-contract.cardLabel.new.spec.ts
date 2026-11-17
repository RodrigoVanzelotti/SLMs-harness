import { describe, expect, it } from 'vitest';
import { cardLabel } from '@amazon-mvp/api-contract';

describe('cardLabel', () => {
  it('names the brand and the last four digits', () => {
    expect(cardLabel({ brand: 'VISA', last4: '4242' })).toBe('Visa final 4242');
    expect(cardLabel({ brand: 'MASTERCARD', last4: '5100' })).toBe('Mastercard final 5100');
    expect(cardLabel({ brand: 'ELO', last4: '0001' })).toBe('Elo final 0001');
    expect(cardLabel({ brand: 'AMEX', last4: '0005' })).toBe('American Express final 0005');
    expect(cardLabel({ brand: 'HIPERCARD', last4: '9999' })).toBe('Hipercard final 9999');
  });
});
