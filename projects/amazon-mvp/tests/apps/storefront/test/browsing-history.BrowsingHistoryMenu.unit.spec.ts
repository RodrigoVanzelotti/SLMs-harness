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

it('opens the flyout from the navbar item and closes it on outside click and Escape', () => {
  recordProductView({ id: 'book', name: 'Geometria Analítica' });
  render(createElement(BrowsingHistoryMenu));
  const trigger = screen.getByRole('button', { name: 'Histórico de navegação' });
  expect(screen.queryByRole('heading', { name: 'Seu histórico de navegação' })).toBeNull();

  fireEvent.click(trigger);
  expect(trigger.getAttribute('aria-expanded')).toBe('true');
  expect(screen.getByRole('link', { name: /Geometria Analítica/ })).toBeTruthy();

  fireEvent.pointerDown(document.body);
  expect(trigger.getAttribute('aria-expanded')).toBe('false');

  fireEvent.click(trigger);
  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  });
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
});
