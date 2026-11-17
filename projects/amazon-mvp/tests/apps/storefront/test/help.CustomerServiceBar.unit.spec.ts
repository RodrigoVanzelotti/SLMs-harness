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

it('marks "Página inicial" as current in the customer service bar', () => {
  render(createElement(CustomerServiceBar, { currentHref: '/help' }));
  const nav = screen.getByRole('navigation', { name: 'Atendimento ao Cliente' });
  expect(
    within(nav).getByRole('link', { name: 'Página inicial' }).getAttribute('aria-current'),
  ).toBe('page');
  expect(
    within(nav)
      .getByRole('link', { name: 'Suporte para dispositivos e serviços digitais' })
      .getAttribute('aria-current'),
  ).toBeNull();
});
