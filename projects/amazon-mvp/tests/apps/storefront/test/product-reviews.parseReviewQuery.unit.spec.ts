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

describe('parseReviewQuery', () => {
  it('reads sort, star filter and page from the URL and ignores anything invalid', () => {
    expect(parseReviewQuery({})).toEqual({ sort: 'helpful', page: 1 });
    expect(parseReviewQuery({ reviewSort: 'recent', reviewStars: '4', reviewPage: '3' })).toEqual({
      sort: 'recent',
      stars: 4,
      page: 3,
    });
    expect(parseReviewQuery({ reviewSort: 'x', reviewStars: '9', reviewPage: '-1' })).toEqual({
      sort: 'helpful',
      page: 1,
    });
  });
});
