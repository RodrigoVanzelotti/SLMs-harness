// @vitest-environment jsdom
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OrderResponse } from '@amazon-mvp/api-contract';
import { CartProvider } from '../src/features/cart/cart-provider';
import { OrdersView } from '../src/features/orders/orders-view';
import {
  deliveryStatus,
  orderCountLabel,
  ordersInPeriod,
  periodOptions,
  returnWindow,
  searchOrders,
} from '../src/features/orders/order-presentation';

vi.mock('next/navigation', () => ({ usePathname: () => '/orders' }));

afterEach(cleanup);

const order = (
  id: string,
  placedAt: string,
  name: string,
  extra: Partial<OrderResponse> = {},
): OrderResponse => ({
  id,
  orderNumber: `702-000000${id.slice(-1)}-1234567`,
  status: 'PENDING',
  subtotalMinor: 32900,
  shippingMinor: 0,
  discountMinor: 0,
  totalMinor: 32900,
  currency: 'BRL',
  shippingAddress: null,
  paymentMethod: 'SIMULATED_CARD',
  paymentCard: null,
  installments: null,
  placedAt,
  deliveredAt: null,
  deliveryNote: null,
  lines: [
    {
      productId: `product-${id}`,
      productName: name,
      sku: 'DEMO-p6',
      quantity: 1,
      unitPriceMinor: 32900,
      lineTotalMinor: 32900,
      currency: 'BRL',
    },
  ],
  ...extra,
});

const NOW = new Date('2026-09-29T12:00:00Z');
const ORDERS = [
  order('o1', '2026-08-10T13:32:00Z', 'Controle Sem Fio para Console, Preto', {
    status: 'FULFILLED',
    deliveredAt: '2026-08-17T15:10:00Z',
    deliveryNote: 'O pacote foi entregue nas mãos de um morador.',
  }),
  order('o2', '2025-05-15T12:00:00Z', 'Kindle 11ª Geração'),
  order('o3', '2024-11-20T12:00:00Z', 'Air Fryer Elétrica'),
];

describe('period filter', () => {
  it('offers only the years that have orders, newest first', () => {
    expect(periodOptions(ORDERS).map((o) => o.label)).toEqual([
      'últimos 30 dias',
      'nos últimos 3 meses',
      '2026',
      '2025',
      '2024',
    ]);
    expect(periodOptions([ORDERS[0], ORDERS[2]]).map((o) => o.value)).toEqual([
      'last30',
      'months3',
      '2026',
      '2024',
    ]);
    expect(periodOptions([]).map((o) => o.value)).toEqual(['last30', 'months3']);
  });

  it('uses Brazilian time for the year boundary', () => {
    // 02:00 UTC on Jan 1st is still Dec 31st in São Paulo.
    const newYearsEve = order('o9', '2026-01-01T02:00:00Z', 'X');
    expect(periodOptions([newYearsEve]).map((o) => o.value)).toContain('2025');
  });
});
