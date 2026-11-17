import { describe, expect, it } from 'vitest';
import { paymentLabel } from '../src/features/orders/order-presentation';

describe('paymentLabel', () => {
  it('labels Pix and missing payment methods', () => {
    expect(paymentLabel({ paymentMethod: 'SIMULATED_PIX', paymentCard: null, installments: null })).toBe(
      'Pix simulado',
    );
    expect(
      paymentLabel({
        paymentMethod: 'SIMULATED_PIX',
        paymentCard: { brand: 'VISA', last4: '1111' },
        installments: 2,
      }),
    ).toBe('Pix simulado');
    expect(paymentLabel({ paymentMethod: null, paymentCard: null, installments: null })).toBe('Não informado');
  });

  it('falls back to the demo Visa for card orders without a card snapshot', () => {
    expect(paymentLabel({ paymentMethod: 'SIMULATED_CARD', paymentCard: null, installments: null })).toBe(
      'Cartão fictício · Visa final 4242',
    );
  });

  it('appends the installment plan when there is one', () => {
    expect(
      paymentLabel({
        paymentMethod: 'SIMULATED_CARD',
        paymentCard: { brand: 'MASTERCARD', last4: '5100' },
        installments: 3,
      }),
    ).toBe('Cartão fictício · Mastercard final 5100 · 3x sem juros');
    expect(
      paymentLabel({
        paymentMethod: 'SIMULATED_CARD',
        paymentCard: { brand: 'ELO', last4: '1234' },
        installments: 1,
      }),
    ).toBe('Cartão fictício · Elo final 1234 · à vista');
    expect(
      paymentLabel({
        paymentMethod: 'SIMULATED_CARD',
        paymentCard: { brand: 'AMEX', last4: '0005' },
        installments: 0,
      }),
    ).toBe('Cartão fictício · American Express final 0005');
  });
});
