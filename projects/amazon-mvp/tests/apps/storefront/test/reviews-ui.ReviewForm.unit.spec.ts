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

describe('ReviewForm', () => {
  const renderForm = (initial?: { rating: number; title: string; body: string }) =>
    render(
      createElement(ReviewForm, {
        productId: 'uuid-p6',
        productHref: '/products/p6',
        loginHref: '/login?next=%2Fproducts%2Fp6%2Freview',
        initial,
      }),
    );

  it('validates like the API', () => {
    expect(validateReview({ rating: 0, title: ' a ', body: 'curto' })).toEqual({
      rating: expect.any(String),
      title: expect.any(String),
      body: expect.any(String),
    });
    expect(validateReview({ rating: 5, title: 'Bom', body: 'Dez letras' })).toEqual({});
  });

  it('uses a native radio group for the stars and blocks invalid submissions', () => {
    renderForm();
    const group = screen.getByRole('group', { name: 'Classificação geral' });
    const stars = within(group).getAllByRole('radio');
    expect(stars).toHaveLength(5);
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText('Selecione uma classificação por estrelas.')).toBeTruthy();
    expect(document.activeElement).toBe(stars[0]);
    expect(screen.getByLabelText('Adicione um título').getAttribute('aria-invalid')).toBe('true');
  });

  it('publishes a new review and returns to the product with feedback', async () => {
    fetchMock.mockResolvedValue(reply(200, {}));
    renderForm();
    fireEvent.click(screen.getByLabelText('4 estrelas: Gostei'));
    fireEvent.change(screen.getByLabelText('Adicione um título'), {
      target: { value: '  Muito bom  ' },
    });
    fireEvent.change(screen.getByLabelText('Adicione uma avaliação escrita'), {
      target: { value: 'Uso todos os dias no PC.' },
    });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Enviar' })));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/v1/reviews/mine');
    expect(JSON.parse(init.body)).toEqual({
      productId: 'uuid-p6',
      rating: 4,
      title: 'Muito bom',
      body: 'Uso todos os dias no PC.',
    });
    expect(push).toHaveBeenCalledWith('/products/p6?review=published#customer-reviews');
  });

  it('prefills an existing review and sends expired sessions to sign in', async () => {
    fetchMock.mockResolvedValue(reply(401, null));
    renderForm({ rating: 2, title: 'Antigo', body: 'Texto antigo da avaliação.' });
    expect((screen.getByLabelText('2 estrelas: Não gostei') as HTMLInputElement).checked).toBe(
      true,
    );
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Salvar alterações' })),
    );
    expect(push).toHaveBeenCalledWith('/login?next=%2Fproducts%2Fp6%2Freview');
  });
});
