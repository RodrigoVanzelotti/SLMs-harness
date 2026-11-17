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

it('refreshes retired illustrations without changing the saved visit', () => {
  const entry = {
    id: 'existing-product-uuid',
    name: 'Tênis salvo',
    viewedAt: now.toISOString(),
    image: { src: '/images/products/catalog/stride-aero-3-preto.svg', alt: 'Ilustração' },
  };
  window.localStorage.setItem('az-browsing-history', JSON.stringify([entry]));
  render(createElement(BrowsingHistoryStrip, { now }));
  const photo = screen.getByRole('img');
  expect(photo.getAttribute('src')).toContain('stride-aero-3-preto.jpg');
  expect(screen.getByRole('link').getAttribute('href')).toBe('/products/existing-product-uuid');
  expect(JSON.parse(window.localStorage.getItem('az-browsing-history')!)).toEqual([entry]);
});

it('shows the empty state when nothing was viewed', () => {
  render(createElement(BrowsingHistoryStrip, { now }));
  expect(screen.getByRole('heading', { name: 'Seu histórico de navegação' })).toBeTruthy();
  expect(screen.getByText(/Os produtos que você visualizar aparecerão aqui/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Exibir e editar' })).toBeNull();
});

it('renders products with cart badge, one date per day and editable entries', () => {
  recordProductView({ id: 'rodo', name: 'Rodo Plástico' }, daysAgo(3, 9));
  recordProductView({ id: 'battery', name: 'Bateria Alcalina A23' }, daysAgo(3, 18));
  recordProductView({ id: 'book', name: 'Geometria Analítica' }, daysAgo(1));
  render(createElement(BrowsingHistoryStrip, { now }));

  const items = screen.getAllByRole('article');
  expect(items.map((item) => within(item).getByRole('link').getAttribute('href'))).toEqual([
    '/products/book',
    '/products/battery',
    '/products/rodo',
  ]);
  expect(items.map((item) => item.querySelector('time')?.textContent)).toEqual([
    'Ontem',
    'Sáb, Set 26',
    '',
  ]);
  expect(within(items[1]).getByText('No carrinho')).toBeTruthy();
  expect(within(items[0]).queryByText('No carrinho')).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'Exibir e editar' }));
  fireEvent.click(within(items[0]).getByRole('button', { name: 'Remover' }));
  expect(screen.getAllByRole('article')).toHaveLength(2);

  fireEvent.click(screen.getByRole('button', { name: 'Limpar histórico' }));
  expect(screen.queryAllByRole('article')).toHaveLength(0);
});
