import { describe, expect, it } from 'vitest';
import { formatLongDate } from '../src/features/orders/order-presentation';

describe('formatLongDate', () => {
  it('formats the long pt-BR date "D de mês de AAAA"', () => {
    expect(formatLongDate('2026-08-10T13:32:00Z')).toBe('10 de agosto de 2026');
    expect(formatLongDate('2026-03-01T12:00:00Z')).toBe('1 de março de 2026');
  });

  it('uses São Paulo time, not UTC', () => {
    expect(formatLongDate('2026-01-01T02:00:00Z')).toBe('31 de dezembro de 2025');
  });
});
