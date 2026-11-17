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

  it('formats the banner date like Amazon, in Brazilian time', () => {
    expect(formatPurchaseDate('2026-08-10T13:32:00.000Z')).toBe('10 de Ago de 2026');
    // 01:00 UTC is still the previous day in São Paulo.
    expect(formatPurchaseDate('2026-08-11T01:00:00.000Z')).toBe('10 de Ago de 2026');
    expect(formatReviewDate('2026-07-18')).toBe('18 de julho de 2026');
  });
});
