import { describe, expect, it } from 'vitest';
import { orderYear } from '../src/features/orders/order-presentation';

describe('orderYear', () => {
  it('returns the calendar year as a number', () => {
    expect(orderYear('2024-11-20T12:00:00Z')).toBe(2024);
    expect(typeof orderYear('2024-11-20T12:00:00Z')).toBe('number');
  });

  it('uses São Paulo time for the year boundary', () => {
    expect(orderYear('2026-01-01T02:00:00Z')).toBe(2025);
    expect(orderYear('2026-01-01T03:00:00Z')).toBe(2026);
  });
});
