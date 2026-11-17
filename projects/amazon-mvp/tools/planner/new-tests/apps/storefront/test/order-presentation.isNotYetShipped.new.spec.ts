import { describe, expect, it } from 'vitest';
import type { OrderResponse } from '@amazon-mvp/api-contract';
import { isNotYetShipped } from '../src/features/orders/order-presentation';

const withStatus = (status: OrderResponse['status']) => ({ status }) as OrderResponse;

describe('isNotYetShipped', () => {
  it('is true only for PENDING and PAID orders', () => {
    expect(isNotYetShipped(withStatus('PENDING'))).toBe(true);
    expect(isNotYetShipped(withStatus('PAID'))).toBe(true);
    expect(isNotYetShipped(withStatus('FULFILLED'))).toBe(false);
    expect(isNotYetShipped(withStatus('CANCELLED'))).toBe(false);
  });
});
