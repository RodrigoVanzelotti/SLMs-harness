// @vitest-environment jsdom
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const push = vi.fn();
const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh }) }));
vi.mock('next/image', () => ({
  default: (props: Record<string, unknown>) => createElement('img', props),
}));

import { CustomerReviews } from '../src/features/product/reviews/customer-reviews';
import type {
  CustomerReview,
  ProductReviews,
} from '../src/features/product/reviews/product-reviews';
import { ReviewFeedback } from '../src/features/product/reviews/review-interactions';
import { ReviewForm, validateReview } from '../src/features/product/reviews/review-form';

const fetchMock = vi.fn();
beforeEach(() => {
  push.mockReset();
  refresh.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const reply = (status: number, body: unknown) =>
  ({ ok: status < 400, status, json: async () => body }) as Response;

const customerReview = (extra: Partial<CustomerReview> = {}): CustomerReview => ({
  id: 'r1',
  productId: 'uuid-p6',
  author: 'Camila S.',
  rating: 4,
  title: 'Muito bom',
  date: '2026-09-02',
  country: 'Brasil',
  variant: [],
  verified: false,
  body: 'Linha 1\nLinha 2',
  helpfulCount: 2,
  own: false,
  votedHelpful: false,
  ...extra,
});
const reviews = (extra: Partial<ProductReviews> = {}): ProductReviews => ({
  summary: { average: 4.3, count: 3, distribution: [67, 0, 0, 33, 0] },
  media: [],
  reviews: [customerReview()],
  total: 1,
  pageSize: 8,
  query: { sort: 'helpful', page: 1 },
  signedIn: true,
  hasOwnReview: false,
  unavailable: false,
  ...extra,
});
const renderSection = (data: ProductReviews, notice?: 'published' | 'updated') =>
  render(
    createElement(CustomerReviews, {
      reviews: data,
      writeReviewHref: '/products/p6/review',
      productPath: '/products/p6',
      loginHref: '/login?next=%2Fproducts%2Fp6',
      notice,
    }),
  );

describe('CustomerReviews', () => {
  it('shows the API summary with star-filter links and sort controls', () => {
    renderSection(reviews());
    expect(screen.getByText('4,3 de 5')).toBeTruthy();
    expect(screen.getByText('3 avaliações globais')).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'Ver avaliações com 2 estrelas' }).getAttribute('href'),
    ).toBe('/products/p6?reviewStars=2#customer-reviews');
    const controls = screen.getByRole('navigation', { name: 'Organizar avaliações' });
    expect(
      within(controls).getByRole('link', { name: 'Mais recentes' }).getAttribute('href'),
    ).toBe('/products/p6?reviewSort=recent#customer-reviews');
    expect(
      within(controls).getByRole('link', { name: 'Mais úteis' }).getAttribute('aria-current'),
    ).toBe('true');
    expect(screen.getByText('2 pessoas acharam isso útil')).toBeTruthy();
    expect(screen.queryByText('Compra verificada')).toBeNull();
    expect(screen.queryByText('Fotos e vídeos de clientes')).toBeNull();
  });

  it('is honest for products without reviews: empty state and a write CTA', () => {
    renderSection(reviews({ summary: null, reviews: [], total: 0 }));
    expect(screen.getByText('Ainda não há avaliações de clientes para este produto.')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByText(/de 5/)).toBeNull();
    expect(
      screen.getByRole('link', { name: 'Escreva uma avaliação' }).getAttribute('href'),
    ).toBe('/products/p6/review');
  });

  it('keeps an active filter, paginates and offers editing the own review', () => {
    renderSection(
      reviews({
        query: { sort: 'recent', stars: 4, page: 2 },
        total: 20,
        hasOwnReview: true,
        reviews: [customerReview({ own: true, editHref: '/products/p6/review', verified: true })],
      }),
      'updated',
    );
    expect(screen.getByRole('status').textContent).toBe('Sua avaliação foi atualizada.');
    expect(screen.getByRole('heading', { name: 'Avaliações com 4 estrelas' })).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'Remover o filtro de 4 estrelas' }).getAttribute('href'),
    ).toBe('/products/p6?reviewSort=recent#customer-reviews');
    const pages = screen.getByRole('navigation', { name: 'Páginas de avaliações' });
    expect(pages.textContent).toContain('Página 2 de 3');
    expect(within(pages).getByRole('link', { name: 'Próxima ›' }).getAttribute('href')).toBe(
      '/products/p6?reviewSort=recent&reviewStars=4&reviewPage=3#customer-reviews',
    );
    expect(screen.getAllByRole('link', { name: 'Editar sua avaliação' })).toHaveLength(2);
    expect(screen.getByText('Sua avaliação')).toBeTruthy();
    expect(screen.getByText('Compra verificada')).toBeTruthy();
    // Authors cannot vote their own review.
    expect(screen.queryByRole('button', { name: 'Útil' })).toBeNull();
  });

  it('says when the reviews service is unavailable instead of guessing', () => {
    renderSection(reviews({ summary: null, reviews: [], total: 0, unavailable: true }));
    expect(screen.getByText(/Não foi possível carregar as avaliações/)).toBeTruthy();
  });
});
