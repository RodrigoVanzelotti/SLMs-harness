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

describe('variant matrix', () => {
  it('lists every value once, marks the current one and links each to its own record', () => {
    const current = member('mint', 'Hortelã');
    const members = [current, member('peach', 'Pêssego'), member('purple', 'Roxa')];
    const [color] = variantDimensions(current, members);
    expect(color.name).toBe('Cor');
    expect(color.selected).toBe('Hortelã');
    expect(color.choices.map((c) => [c.value, c.selected, c.member.product.slug])).toEqual([
      ['Hortelã', true, 'mint'],
      ['Pêssego', false, 'peach'],
      ['Roxa', false, 'purple'],
    ]);
  });

  it('keeps the other current options when switching one dimension', () => {
    const current = member('black-m', 'Preto', 'M');
    const members = [
      current,
      member('black-g', 'Preto', 'G'),
      member('white-p', 'Branco', 'P'),
      member('white-m', 'Branco', 'M'),
    ];
    const [color, size] = variantDimensions(current, members);
    // White keeps size M instead of jumping to the first white record (P).
    expect(color.choices.find((c) => c.value === 'Branco')?.member.product.slug).toBe('white-m');
    // No black P exists, so P falls back to the first record with that size.
    expect(size.choices.find((c) => c.value === 'P')?.member.product.slug).toBe('white-p');
  });
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
