import { describe, expect, it } from 'vitest';
import type { OrderResponse } from '@amazon-mvp/api-contract';
import { deliveryStatus } from '../src/features/orders/order-presentation';

const order = (extra: Partial<OrderResponse> = {}): OrderResponse => ({
  id: 'o1',
  orderNumber: '702-0000001-1234567',
  status: 'PENDING',
  subtotalMinor: 10000,
  shippingMinor: 0,
  discountMinor: 0,
  totalMinor: 10000,
  currency: 'BRL',
  shippingAddress: null,
  paymentMethod: 'SIMULATED_PIX',
  paymentCard: null,
  installments: null,
  placedAt: '2026-08-10T13:32:00Z',
  deliveredAt: null,
  deliveryNote: null,
  lines: [],
  ...extra,
});

describe('deliveryStatus', () => {
  it('reports placed orders as received and not shipped yet', () => {
    expect(deliveryStatus(order())).toEqual({ headline: 'Pedido recebido', detail: 'Ainda não enviado.' });
    expect(deliveryStatus(order({ status: 'PAID' }))).toEqual({
      headline: 'Pedido recebido',
      detail: 'Ainda não enviado.',
    });
    expect(deliveryStatus(order({ deliveryNote: 'Separando os itens.' }))).toEqual({
      headline: 'Pedido recebido',
      detail: 'Separando os itens.',
    });
  });

  it('reports fulfilled orders without a delivery date as shipped', () => {
    expect(deliveryStatus(order({ status: 'FULFILLED' }))).toEqual({ headline: 'Enviado', detail: null });
    expect(deliveryStatus(order({ status: 'FULFILLED', deliveryNote: 'A caminho' }))).toEqual({
      headline: 'Enviado',
      detail: 'A caminho',
    });
  });

  it('shows the delivery day and month in São Paulo time, without "de"', () => {
    expect(
      deliveryStatus(
        order({ status: 'FULFILLED', deliveredAt: '2026-08-17T15:10:00Z', deliveryNote: 'Entregue.' }),
      ),
    ).toEqual({ headline: 'Entregue no dia 17 agosto', detail: 'Entregue.' });
    expect(deliveryStatus(order({ status: 'FULFILLED', deliveredAt: '2026-08-01T02:10:00Z' }))).toEqual({
      headline: 'Entregue no dia 31 julho',
      detail: null,
    });
    // A delivery date wins over any status other than CANCELLED.
    expect(deliveryStatus(order({ deliveredAt: '2026-08-01T15:10:00Z' })).headline).toBe(
      'Entregue no dia 1 agosto',
    );
  });

  it('reports cancelled orders as cancelled, even with a delivery date', () => {
    expect(deliveryStatus(order({ status: 'CANCELLED' }))).toEqual({ headline: 'Cancelado', detail: null });
    expect(
      deliveryStatus(
        order({ status: 'CANCELLED', deliveredAt: '2026-08-17T15:10:00Z', deliveryNote: 'Estornado.' }),
      ),
    ).toEqual({ headline: 'Cancelado', detail: 'Estornado.' });
  });
});
