import { describe, expect, it } from 'vitest';
import type { CartResponse } from '@amazon-mvp/api-contract';
import { cartContentKey } from '../src/features/checkout/checkout-client';

const line = (productId: string, quantity: number, unitPriceMinor: number, availableQuantity = 5) => ({
  productId,
  quantity,
  unitPriceMinor,
  lineTotalMinor: quantity * unitPriceMinor,
  product: {
    id: productId,
    sku: `SKU-${productId}`,
    slug: productId,
    name: `Produto ${productId}`,
    description: null,
    priceMinor: unitPriceMinor,
    currency: 'BRL',
    active: true,
    availableQuantity,
    inStock: availableQuantity > 0,
  },
});
const cart = (lines: CartResponse['lines'], extra: Partial<CartResponse> = {}): CartResponse => ({
  id: 'cart-1',
  userId: 'user-1',
  lines,
  itemCount: lines.reduce((sum, l) => sum + l.quantity, 0),
  subtotalMinor: lines.reduce((sum, l) => sum + l.lineTotalMinor, 0),
  currency: 'BRL',
  ...extra,
});

describe('cartContentKey', () => {
  it('is "null" without a cart', () => {
    expect(cartContentKey(null)).toBe('null');
  });

  it('serializes id, currency and the lines sorted by product id', () => {
    const value = cart([line('b', 1, 1099, 3), line('a', 2, 500)]);
    expect(cartContentKey(value)).toBe('["cart-1","BRL",["a",2,500,true,5],["b",1,1099,true,3]]');
    // The cart itself is not reordered.
    expect(value.lines.map((l) => l.productId)).toEqual(['b', 'a']);
  });

  it('ignores line order and derived totals', () => {
    const a = cart([line('a', 2, 500), line('b', 1, 1099)]);
    const b = cart([line('b', 1, 1099), line('a', 2, 500)], { itemCount: 99, subtotalMinor: 1 });
    expect(cartContentKey(a)).toBe(cartContentKey(b));
  });

  it('changes with quantity, price, availability, activity, id or currency', () => {
    const base = cartContentKey(cart([line('a', 2, 500)]));
    expect(cartContentKey(cart([line('a', 3, 500)]))).not.toBe(base);
    expect(cartContentKey(cart([line('a', 2, 501)]))).not.toBe(base);
    expect(cartContentKey(cart([line('a', 2, 500, 1)]))).not.toBe(base);
    const inactive = line('a', 2, 500);
    inactive.product.active = false;
    expect(cartContentKey(cart([inactive]))).not.toBe(base);
    expect(cartContentKey(cart([line('a', 2, 500)], { id: null }))).not.toBe(base);
    expect(cartContentKey(cart([line('a', 2, 500)], { currency: 'USD' }))).not.toBe(base);
  });
});
