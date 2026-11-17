import { describe, expect, it } from 'vitest';
import { discountLabel } from '../src/features/orders/order-presentation';

describe('discountLabel', () => {
  it('names the Pix discount and labels anything else generically', () => {
    expect(discountLabel({ paymentMethod: 'SIMULATED_PIX' })).toBe('Desconto Pix');
    expect(discountLabel({ paymentMethod: 'SIMULATED_CARD' })).toBe('Desconto');
    expect(discountLabel({ paymentMethod: null })).toBe('Desconto');
  });
});
