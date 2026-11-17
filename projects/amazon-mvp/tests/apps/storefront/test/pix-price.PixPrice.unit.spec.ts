// @vitest-environment jsdom
import { createElement } from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CartResponse } from '@amazon-mvp/api-contract';
import { PixPrice } from '../src/features/checkout/pix-price';
import { CartContent } from '../src/features/cart/cart-content';
import { useCart } from '../src/features/cart/cart-provider';

vi.mock('../src/features/cart/cart-provider', () => ({ useCart: vi.fn() }));
afterEach(cleanup);

const text = (amountMinor: number, percent: number | null) =>
  render(createElement(PixPrice, { amountMinor, currency: 'BRL', percent })).container.textContent;

describe('PixPrice', () => {
  it('uses the checkout rounding rule (discount rounded down)', () => {
    expect(text(32900, 5)).toMatch(/^R\$\s312,55 no Pix \(5% de desconto\)$/);
    cleanup();
    expect(text(99999, 5)).toMatch(/^R\$\s950,00 no Pix/);
    cleanup();
    expect(text(20, 5)).toMatch(/^R\$\s0,19 no Pix/);
  });

  it('renders nothing without a rate or when the discount rounds to zero', () => {
    expect(text(32900, null)).toBe('');
    expect(text(32900, 0)).toBe('');
    expect(text(19, 5)).toBe('');
  });
});
