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

describe('CustomerArticle', () => {
  it('renders title, breadcrumb, sections and the anchors to them', () => {
    const page = CUSTOMER_PAGES.shipping;
    render(createElement(CustomerArticle, { page }));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(page.title);
    const crumbs = screen.getByRole('navigation', { name: 'Trilha de navegação' });
    expect(
      within(crumbs).getByRole('link', { name: 'Atendimento ao Cliente' }).getAttribute('href'),
    ).toBe('/help');
    expect(crumbs.textContent).toContain('Envios e entregas');

    const h2 = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(h2).toEqual([
      ...page.sections.map((s) => s.title),
      'Tópicos relacionados',
      'Mais tópicos de ajuda',
    ]);
    const toc = screen.getByRole('navigation', { name: 'Nesta página' });
    expect(
      within(toc)
        .getAllByRole('link')
        .map((a) => a.getAttribute('href')),
    ).toEqual(page.sections.map((s) => `#${s.id}`));
    for (const section of page.sections) expect(document.getElementById(section.id)).not.toBeNull();
    expect(screen.getByRole('table', { name: 'Status exibidos em Seus pedidos' })).toBeTruthy();
  });

  it('marks the current page in the sidebar and lists all seven pages', () => {
    render(createElement(CustomerArticle, { page: CUSTOMER_PAGES.returns }));
    const aside = screen.getByRole('complementary', { name: 'Mais tópicos de ajuda' });
    const links = within(aside).getAllByRole('link');
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      ...PAGES.map((p) => p.href),
      '/help',
    ]);
    expect(
      within(aside)
        .getByRole('link', { name: 'Devoluções e reembolsos' })
        .getAttribute('aria-current'),
    ).toBe('page');
    expect(
      within(aside)
        .getByRole('link', { name: 'Frete e prazo de entrega' })
        .getAttribute('aria-current'),
    ).toBeNull();
  });

  it('shows the honest notice and keyboard-friendly FAQ accordions', () => {
    render(createElement(CustomerArticle, { page: CUSTOMER_PAGES.returns }));
    expect(screen.getByRole('note', { name: CUSTOMER_PAGES.returns.notice!.title })).toBeTruthy();
    const summaries = document.querySelectorAll('details > summary');
    expect(summaries.length).toBeGreaterThan(0);
    expect(summaries[0].textContent).toBe('Recebi um produto com defeito. O que faço?');
  });

  it('renders the recall empty state instead of fake records', () => {
    render(createElement(CustomerArticle, { page: CUSTOMER_PAGES.recalls }));
    expect(screen.getByRole('status').textContent).toContain(
      'Não há recalls ativos para produtos desta loja',
    );
    expect(screen.queryByRole('searchbox')).toBeNull();
  });

  it('fills the transactions slot on the payment page', () => {
    render(
      createElement(CustomerArticle, {
        page: CUSTOMER_PAGES.paymentMethods,
        slots: { transactions: createElement('p', null, 'slot-content') },
      }),
    );
    const section = document.getElementById('transacoes')!;
    expect(section.textContent).toContain('slot-content');
    expect(screen.getByRole('heading', { level: 3, name: 'Cartão de crédito' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 3, name: 'Pix' })).toBeTruthy();
  });
});
