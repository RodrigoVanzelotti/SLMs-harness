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

it('derives delivery status and return window from the persisted order', () => {
  expect(deliveryStatus(ORDERS[0])).toEqual({
    headline: 'Entregue no dia 17 agosto',
    detail: 'O pacote foi entregue nas mãos de um morador.',
  });
  expect(deliveryStatus(ORDERS[1]).headline).toBe('Pedido recebido');
  expect(returnWindow(ORDERS[0], NOW)).toBe(
    'O período de devolução se encerrou em 17 de setembro de 2026',
  );
  expect(returnWindow(ORDERS[1], NOW)).toBeNull();
});
