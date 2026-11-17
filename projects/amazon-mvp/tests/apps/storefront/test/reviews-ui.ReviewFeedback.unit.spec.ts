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

describe('ReviewFeedback ("Útil")', () => {
  const renderFeedback = (extra: Record<string, unknown> = {}) =>
    render(
      createElement(ReviewFeedback, {
        reviewId: 'r1',
        helpfulCount: 2,
        votedHelpful: false,
        own: false,
        signedIn: true,
        loginHref: '/login?next=x',
        ...extra,
      }),
    );

  it('counts optimistically, then keeps the server count', async () => {
    let resolve!: (response: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>((r) => (resolve = r)));
    renderFeedback();
    fireEvent.click(screen.getByRole('button', { name: 'Útil' }));
    expect(screen.getByText('3 pessoas acharam isso útil')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('Obrigado pelo seu feedback.');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/reviews/r1/helpful',
      expect.objectContaining({ method: 'PUT' }),
    );
    await act(async () => resolve(reply(200, { reviewId: 'r1', helpfulCount: 5, voted: true })));
    expect(screen.getByText('5 pessoas acharam isso útil')).toBeTruthy();
  });

  it('rolls back and explains when the vote fails', async () => {
    fetchMock.mockResolvedValue(reply(500, null));
    renderFeedback();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Útil' })));
    expect(screen.getByText('2 pessoas acharam isso útil')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(/Não foi possível registrar/);
    expect(screen.getByRole('button', { name: 'Útil' })).toBeTruthy();
  });

  it('sends guests to sign in and never calls the API', () => {
    renderFeedback({ signedIn: false });
    fireEvent.click(screen.getByRole('button', { name: 'Útil' }));
    expect(push).toHaveBeenCalledWith('/login?next=x');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows an existing vote as already thanked', () => {
    renderFeedback({ votedHelpful: true });
    expect(screen.queryByRole('button', { name: 'Útil' })).toBeNull();
    expect(screen.getByText('Obrigado pelo seu feedback.')).toBeTruthy();
  });
});
