import { describe, expect, it } from 'vitest';
import { formatOrderDate } from '../src/features/orders/order-presentation';

describe('formatOrderDate', () => {
  it('formats the short pt-BR date "D de mmm. de AAAA"', () => {
    expect(formatOrderDate('2026-08-10T13:32:00Z')).toBe('10 de ago. de 2026');
    expect(formatOrderDate('2025-05-09T12:00:00Z')).toBe('9 de mai. de 2025');
    expect(formatOrderDate('2026-12-25T12:00:00Z')).toBe('25 de dez. de 2026');
  });

  it('uses São Paulo time, not UTC', () => {
    // 02:00 UTC on Jan 1st is still Dec 31st in São Paulo.
    expect(formatOrderDate('2026-01-01T02:00:00Z')).toBe('31 de dez. de 2025');
  });
});
