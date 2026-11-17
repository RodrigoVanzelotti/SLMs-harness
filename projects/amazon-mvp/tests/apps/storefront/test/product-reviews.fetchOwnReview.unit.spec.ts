import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogItem, ReviewResponse } from '@amazon-mvp/api-contract';

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ cookies: () => ({ toString: () => 'amzmvp_sid=x' }) }));
vi.mock('../src/config/storefront-config', () => ({
  getConfig: () => ({ api: { internalBaseUrl: 'http://api', publicBasePath: '/api/v1' } }),
}));

import {
  fetchOwnReview,
  parseReviewQuery,
  productReviews,
  withRatings,
} from '../src/features/product/reviews/product-reviews';

const review = (id: string, productId: string, extra: Partial<ReviewResponse> = {}) => ({
  id,
  productId,
  authorName: 'Camila S.',
  rating: 5,
  title: 'Ótimo',
  body: 'Funciona muito bem.',
  verifiedPurchase: false,
  helpfulCount: 1,
  // 01:30 UTC is still the previous calendar day in Brasília.
  createdAt: '2026-09-02T01:30:00.000Z',
  updatedAt: '2026-09-02T01:30:00.000Z',
  ...extra,
});

let routes: Record<string, { status?: number; body: unknown }>;
const calls: Array<{ url: string; cookie?: string }> = [];

beforeEach(() => {
  calls.length = 0;
  routes = {};
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, cookie: (init?.headers as Record<string, string>)?.cookie });
      const path = url.replace('http://api/api/v1', '').split('?')[0];
      const route = routes[path];
      if (!route) throw new Error('API down');
      const status = route.status ?? 200;
      return { ok: status < 400, status, json: async () => route.body } as Response;
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('ratings for cards and the write page', () => {
  const item = (id: string) => ({ id, slug: id }) as CatalogItem;

  it('distinguishes unknown products, lost sessions and API failures', async () => {
    routes['/reviews/mine'] = { status: 404, body: {} };
    expect(await fetchOwnReview('x')).toBe('not-found');
    routes['/reviews/mine'] = { status: 401, body: {} };
    expect(await fetchOwnReview('x')).toBe('signed-out');
    routes['/reviews/mine'] = { body: { review: null, verifiedPurchase: true } };
    expect(await fetchOwnReview('x')).toEqual({ review: null, verifiedPurchase: true });
    delete routes['/reviews/mine'];
    expect(await fetchOwnReview('x')).toBeNull();
  });
});
