import { describe, expect, it } from 'vitest';
import type { OrderLineResponse, OrderResponse } from '@amazon-mvp/api-contract';
import { distinctOrderedProducts } from '../src/features/orders/order-presentation';

const line = (productId: string): OrderLineResponse => ({
  productId,
  productName: `Produto ${productId}`,
  sku: `SKU-${productId}`,
  quantity: 1,
  unitPriceMinor: 1000,
  lineTotalMinor: 1000,
  currency: 'BRL',
});
const order = (id: string, placedAt: string, productIds: string[]) =>
  ({ id, placedAt, lines: productIds.map(line) }) as unknown as OrderResponse;

describe('distinctOrderedProducts', () => {
  it('lists each product once, from its newest order, newest order first', () => {
    const january = order('a', '2026-01-01T12:00:00Z', ['x1', 'x2']);
    const march = order('b', '2026-03-01T12:00:00Z', ['x2', 'x3', 'x3']);
    const december = order('c', '2025-12-01T12:00:00Z', ['x4', 'x1']);
    const result = distinctOrderedProducts([january, march, december]);
    expect(result.map(({ line, order }) => `${line.productId}@${order.id}`)).toEqual([
      'x2@b',
      'x3@b',
      'x1@a',
      'x4@c',
    ]);
    expect(result[0].line).toBe(march.lines[0]);
    expect(result[0].order).toBe(march);
  });

  it('does not reorder the input array', () => {
    const orders = [order('a', '2026-01-01T12:00:00Z', ['x1']), order('b', '2026-03-01T12:00:00Z', ['x2'])];
    distinctOrderedProducts(orders);
    expect(orders.map((o) => o.id)).toEqual(['a', 'b']);
  });

  it('returns an empty list without orders', () => {
    expect(distinctOrderedProducts([])).toEqual([]);
  });
});
