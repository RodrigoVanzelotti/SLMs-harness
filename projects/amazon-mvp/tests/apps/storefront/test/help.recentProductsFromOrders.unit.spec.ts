// @vitest-environment jsdom
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { OrderResponse } from '@amazon-mvp/api-contract';
import { CustomerServiceBar, HelpCenter } from '../src/features/help/help-center';
import { HELP_CATEGORIES } from '../src/features/help/help-content';
import { searchHelpTopics } from '../src/features/help/help-topics';
import {
  RecentProduct,
  formatOrderDate,
  recentProductsFromOrders,
} from '../src/features/help/recent-products';

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ cookies: () => ({ toString: () => '' }) }));

afterEach(cleanup);

type Line = { productId: string; productName: string; sku?: string };
const order = (id: string, placedAt: string, lines: Line[]): OrderResponse =>
  ({
    id,
    placedAt,
    lines: lines.map((line) => ({ sku: 'NO-MEDIA', ...line })),
  }) as OrderResponse;
const item = (name: string, sku?: string): Line => ({ productId: name, productName: name, sku });

const ORDERS = [
  order('o1', '2026-03-12T12:00:00Z', [item('Kindle', 'DEMO-p3')]),
  order('o2', '2026-08-10T12:00:00Z', [item('Controle', 'DEMO-p6')]),
];

const renderHelp = (firstName?: string, products: RecentProduct[] = []) =>
  render(createElement(HelpCenter, { firstName, products }));

it('builds recent products from orders: newest first, distinct, at most six', () => {
  const recent = recentProductsFromOrders([
    order('o1', '2026-01-01T12:00:00Z', [item('Kindle', 'DEMO-p3'), item('A')]),
    order(
      'o2',
      '2026-02-01T12:00:00Z',
      ['B', 'A', 'C', 'D', 'E', 'F', 'G'].map((n) => item(n)),
    ),
  ]);
  expect(recent.map((p) => p.name)).toEqual(['B', 'A', 'C', 'D', 'E', 'F']);
  expect(recent.every((p) => p.href === '/orders/o2')).toBe(true);
});

it('takes the photo from the order item SKU and leaves unknown SKUs without one', () => {
  const [kindle, other] = recentProductsFromOrders([
    order('o1', '2026-01-01T12:00:00Z', [item('Kindle', 'DEMO-p3'), item('Sem foto')]),
  ]);
  expect(kindle.image?.src).toBe('/images/products/kindle.jpg');
  expect(other.image).toBeUndefined();
  expect(formatOrderDate('2025-05-09T12:00:00Z')).toBe('9 de mai. de 2025');
});
