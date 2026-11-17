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

it('records the most recent view first without duplicates and ignores corrupt storage', () => {
  window.localStorage.setItem('az-browsing-history', '{not json');
  recordProductView({ id: 'a', name: 'A' }, daysAgo(2));
  recordProductView({ id: 'b', name: 'B' }, daysAgo(1));
  recordProductView({ id: 'a', name: 'A' }, daysAgo(0));

  const stored = JSON.parse(window.localStorage.getItem('az-browsing-history') ?? '[]');
  expect(stored.map((entry: { id: string }) => entry.id)).toEqual(['a', 'b']);
});
