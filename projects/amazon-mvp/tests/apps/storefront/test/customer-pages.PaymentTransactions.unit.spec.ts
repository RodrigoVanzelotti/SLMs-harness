// @vitest-environment jsdom
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { OrderResponse } from '@amazon-mvp/api-contract';
import { CustomerArticle } from '../src/features/customer-pages/customer-article';
import { InstallmentExample } from '../src/features/customer-pages/customer-blocks';
import {
  CUSTOMER_PAGES,
  CUSTOMER_PAGE_ORDER,
  ContentBlock,
  CustomerPage,
  RichText,
  customerPageMetadata,
} from '../src/features/customer-pages/customer-page-content';
import {
  PaymentTransactions,
  TRANSACTIONS_LIMIT,
} from '../src/features/customer-pages/payment-transactions';

afterEach(cleanup);

const PAGES = CUSTOMER_PAGE_ORDER.map((key) => CUSTOMER_PAGES[key]);
const APP = join(process.cwd(), 'src', 'app');

const richText = (text: RichText): string =>
  typeof text === 'string'
    ? text
    : text.map((part) => (typeof part === 'string' ? part : part.text)).join('');
const richLinks = (text: RichText): string[] =>
  typeof text === 'string'
    ? []
    : text.flatMap((part) => (typeof part === 'string' ? [] : [part.href]));

function blockTexts(block: ContentBlock): { text: string[]; hrefs: string[] } {
  switch (block.kind) {
    case 'text':
      return { text: block.paragraphs.map(richText), hrefs: block.paragraphs.flatMap(richLinks) };
    case 'list':
      return { text: block.items.map(richText), hrefs: block.items.flatMap(richLinks) };
    case 'steps':
      return {
        text: block.items.flatMap((s) => [s.title, richText(s.body)]),
        hrefs: block.items.flatMap((s) => richLinks(s.body)),
      };
    case 'facts':
      return {
        text: block.items.flatMap((f) => [f.term, richText(f.detail)]),
        hrefs: block.items.flatMap((f) => richLinks(f.detail)),
      };
    case 'methods':
      return {
        text: block.items.flatMap((m) => [m.title, m.label, ...m.points.map(richText)]),
        hrefs: block.items.flatMap((m) => m.points.flatMap(richLinks)),
      };
    case 'links':
      return {
        text: block.items.flatMap((l) => [l.title, l.body]),
        hrefs: block.items.map((l) => l.href),
      };
    case 'faq':
      return {
        text: block.items.flatMap((q) => [q.question, ...q.answer.map(richText)]),
        hrefs: block.items.flatMap((q) => q.answer.flatMap(richLinks)),
      };
    case 'empty':
      return { text: [block.title, block.body], hrefs: [] };
    default:
      return { text: [], hrefs: [] };
  }
}

function pageTexts(page: CustomerPage) {
  const parts = page.sections.flatMap((s) => s.blocks.map(blockTexts));
  const notice = page.notice ? [page.notice.title, richText(page.notice.body)] : [];
  return {
    text: [page.title, page.lead, page.summary, ...notice, ...parts.flatMap((p) => p.text)].join(
      '\n',
    ),
    hrefs: [
      page.href,
      ...parts.flatMap((p) => p.hrefs),
      ...(page.notice ? richLinks(page.notice.body) : []),
    ],
  };
}

describe('PaymentTransactions', () => {
  const order = (n: number, placedAt: string, extra: Partial<OrderResponse> = {}) =>
    ({
      id: `id-${n}`,
      orderNumber: `000-${n}`,
      placedAt,
      totalMinor: n * 1000,
      currency: 'BRL',
      paymentMethod: 'SIMULATED_PIX',
      ...extra,
    }) as OrderResponse;

  it('asks signed-out visitors to log in and come back', () => {
    render(createElement(PaymentTransactions, { signedIn: false, orders: null }));
    expect(screen.getByRole('link', { name: 'Fazer login' }).getAttribute('href')).toBe(
      '/login?next=%2Fpayment-methods',
    );
  });

  it('reports an unavailable orders API instead of showing nothing', () => {
    render(createElement(PaymentTransactions, { signedIn: true, orders: null }));
    expect(screen.getByRole('alert').textContent).toContain('Não foi possível carregar');
  });

  it('shows an empty message when there are no orders', () => {
    render(createElement(PaymentTransactions, { signedIn: true, orders: [] }));
    expect(screen.getByText(/Você ainda não fez pedidos/)).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('lists the most recent orders with their payment method and total', () => {
    const orders = [
      order(1, '2026-01-01T12:00:00Z', { paymentMethod: 'SIMULATED_CARD' }),
      ...[2, 3, 4, 5, 6].map((n) => order(n, `2026-0${n}-01T12:00:00Z`)),
      order(7, '2025-12-01T12:00:00Z', { paymentMethod: null }),
    ];
    render(createElement(PaymentTransactions, { signedIn: true, orders }));
    const items = within(screen.getByRole('list', { name: 'Transações recentes' })).getAllByRole(
      'listitem',
    );
    expect(items).toHaveLength(TRANSACTIONS_LIMIT);
    expect(items[0].textContent).toContain('Pedido nº 000-6');
    expect(items[0].textContent).toContain('Pix simulado');
    expect(items[0].textContent!.replace(/\s/g, ' ')).toContain('R$ 60,00');
    expect(items[0].querySelector('a')?.getAttribute('href')).toBe('/orders/id-6');
    expect(items.at(-1)!.textContent).toContain('Pedido nº 000-2');
    expect(screen.getByRole('link', { name: 'Ver todos os pedidos' }).getAttribute('href')).toBe(
      '/orders',
    );
  });

  it('labels the simulated card exactly like the checkout', () => {
    render(
      createElement(PaymentTransactions, {
        signedIn: true,
        orders: [order(1, '2026-01-01T12:00:00Z', { paymentMethod: 'SIMULATED_CARD' })],
      }),
    );
    expect(screen.getByText('Cartão fictício · Visa final 4242')).toBeTruthy();
  });

  it('shows the saved card and the installment plan of newer orders', () => {
    render(
      createElement(PaymentTransactions, {
        signedIn: true,
        orders: [
          order(1, '2026-01-01T12:00:00Z', {
            paymentMethod: 'SIMULATED_CARD',
            paymentCard: { brand: 'MASTERCARD', last4: '5100' },
            installments: 3,
          }),
        ],
      }),
    );
    expect(screen.getByText('Cartão fictício · Mastercard final 5100 · 3x sem juros')).toBeTruthy();
  });
});
