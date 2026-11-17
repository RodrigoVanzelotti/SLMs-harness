// @vitest-environment jsdom
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  BrowsingHistoryMenu,
  BrowsingHistoryStrip,
} from '../src/features/browsing-history/browsing-history-menu';
import {
  formatHistoryDay,
  recordProductView,
} from '../src/features/browsing-history/browsing-history-store';
import { useCart } from '../src/features/cart/cart-provider';

vi.mock('../src/features/cart/cart-provider', () => ({ useCart: vi.fn() }));

class NoopResizeObserver {
  observe() {}
  disconnect() {}
}

const now = new Date(2026, 8, 29, 12);
const daysAgo = (days: number, hour = 10) => new Date(2026, 8, 29 - days, hour);

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
  vi.mocked(useCart).mockReturnValue({
    cart: { lines: [{ productId: 'battery' }] },
  } as unknown as ReturnType<typeof useCart>);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('formats timeline days like Amazon', () => {
  expect(formatHistoryDay(daysAgo(0).toISOString(), now)).toBe('Hoje');
  expect(formatHistoryDay(daysAgo(1).toISOString(), now)).toBe('Ontem');
  expect(formatHistoryDay(daysAgo(3).toISOString(), now)).toBe('Sáb, Set 26');
  expect(formatHistoryDay(daysAgo(36).toISOString(), now)).toBe('Seg, Ago 24');
});
