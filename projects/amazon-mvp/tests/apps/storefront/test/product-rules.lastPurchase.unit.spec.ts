import { describe, expect, it } from 'vitest';
import type { CatalogItem, OrderResponse } from '@amazon-mvp/api-contract';
import {
  discountPercent,
  formatPurchaseDate,
  formatReviewDate,
  installmentPlan,
  lastPurchase,
  variantDimensions,
  type VariantMember,
} from '../src/features/product/product-rules';

const item = (slug: string, inStock = true): CatalogItem => ({
  id: `id-${slug}`,
  slug,
  sku: `SKU-${slug}`,
  name: slug,
  description: null,
  priceMinor: 1000,
  currency: 'BRL',
  active: true,
  availableQuantity: inStock ? 3 : 0,
  inStock,
});
const member = (slug: string, color: string, size?: string): VariantMember => ({
  product: item(slug),
  options: [{ name: 'Cor', value: color }, ...(size ? [{ name: 'Tamanho', value: size }] : [])],
});

const order = (
  id: string,
  placedAt: string,
  productIds: string[],
  status: OrderResponse['status'] = 'FULFILLED',
): OrderResponse => ({
  id,
  orderNumber: id,
  status,
  subtotalMinor: 0,
  shippingMinor: 0,
  discountMinor: 0,
  totalMinor: 0,
  currency: 'BRL',
  shippingAddress: null,
  paymentMethod: null,
  paymentCard: null,
  installments: null,
  placedAt,
  deliveredAt: null,
  deliveryNote: null,
  lines: productIds.map((productId) => ({
    productId,
    productName: productId,
    sku: productId,
    quantity: 1,
    unitPriceMinor: 0,
    lineTotalMinor: 0,
    currency: 'BRL',
  })),
});

describe('previous purchase', () => {
  it('returns the newest order that contains the product or one of its variants', () => {
    const orders = [
      order('old', '2026-01-10T10:00:00Z', ['mint']),
      order('new', '2026-08-10T13:32:00Z', ['peach', 'other']),
      order('unrelated', '2026-09-01T10:00:00Z', ['other']),
    ];
    const found = lastPurchase(orders, ['mint', 'peach']);
    expect(found?.order.id).toBe('new');
    expect(found?.line.productId).toBe('peach');
  });

  it('ignores cancelled orders and never invents a purchase', () => {
    expect(
      lastPurchase([order('c', '2026-08-10T00:00:00Z', ['mint'], 'CANCELLED')], ['mint']),
    ).toBeNull();
    expect(lastPurchase([], ['mint'])).toBeNull();
  });
});
