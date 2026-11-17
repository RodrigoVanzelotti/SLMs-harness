import { paymentDiscountPercent } from '@amazon-mvp/api-contract';

describe('paymentDiscountPercent', () => {
  const pricing = { pixDiscountPercent: 5, maxInstallments: 10, minInstallmentMinor: 500 };

  it('applies the configured Pix rate to Pix only', () => {
    expect(paymentDiscountPercent('SIMULATED_PIX', pricing)).toBe(5);
    expect(paymentDiscountPercent('SIMULATED_CARD', pricing)).toBe(0);
  });

  it('follows the configured rate, including 0 and 100', () => {
    expect(paymentDiscountPercent('SIMULATED_PIX', { ...pricing, pixDiscountPercent: 0 })).toBe(0);
    expect(paymentDiscountPercent('SIMULATED_PIX', { ...pricing, pixDiscountPercent: 100 })).toBe(
      100,
    );
    expect(paymentDiscountPercent('SIMULATED_CARD', { ...pricing, pixDiscountPercent: 100 })).toBe(
      0,
    );
  });
});
