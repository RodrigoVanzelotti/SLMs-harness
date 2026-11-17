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

describe('footer help/payment pages content', () => {

  it('gives every page an "X | Amazon.com.br" title', () => {
    expect(customerPageMetadata('shipping').title).toBe('Frete e prazo de entrega | Amazon.com.br');
    for (const page of PAGES) {
      expect(customerPageMetadata(page.key)).toEqual({
        title: `${page.title} | Amazon.com.br`,
        description: page.lead,
      });
    }
  });
});
