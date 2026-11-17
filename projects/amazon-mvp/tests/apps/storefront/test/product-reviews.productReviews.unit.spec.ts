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

describe('productReviews (reviews API source)', () => {
  const variants = new Map([
    ['uuid-p6', [{ name: 'Cor', value: 'Hortelã' }]],
    ['uuid-p23', [{ name: 'Cor', value: 'Verde' }]],
  ]);
  const slugs = new Map([
    ['uuid-p6', 'p6'],
    ['uuid-p23', 'p23'],
  ]);

  it('reads the family pool, labels variants and marks the viewer state', async () => {
    routes['/reviews/summary'] = {
      body: {
        average: 4.8,
        count: 5512,
        distribution: [92, 5, 1, 0, 2].map((percent, i) => ({ stars: 5 - i, percent })),
      },
    };
    routes['/reviews'] = {
      body: {
        items: [
          review('r1', 'uuid-p23', { verifiedPurchase: true }),
          review('r2', 'uuid-p6', { helpfulCount: 0 }),
        ],
        total: 2,
        page: 1,
        pageSize: 8,
      },
    };
    routes['/reviews/viewer'] = {
      body: { ownReviews: [{ id: 'r1', productId: 'uuid-p23' }], helpfulReviewIds: ['r2'] },
    };
    const result = await productReviews({
      productId: 'uuid-p6',
      familyIds: ['uuid-p6', 'uuid-p23'],
      variantOptions: variants,
      productSlugs: slugs,
      query: { sort: 'recent', stars: 5, page: 2 },
      signedIn: true,
    });
    expect(result.summary).toEqual({ average: 4.8, count: 5512, distribution: [92, 5, 1, 0, 2] });
    expect(result.reviews[0]).toMatchObject({
      id: 'r1',
      date: '2026-09-01',
      variant: [{ name: 'Cor', value: 'Verde' }],
      verified: true,
      own: true,
      votedHelpful: false,
      editHref: '/products/p23/review',
    });
    expect(result.reviews[1]).toMatchObject({ own: false, votedHelpful: true });
    expect(result.reviews[1].editHref).toBeUndefined();
    // Own review is on a sibling variant: this product's CTA still says "Escreva".
    expect(result.hasOwnReview).toBe(false);
    expect(result.unavailable).toBe(false);
    const list = calls.find((call) => call.url.includes('/reviews?'))!.url;
    expect(list).toContain('productIds=uuid-p6,uuid-p23');
    expect(list).toContain('sort=recent');
    expect(list).toContain('stars=5');
    expect(list).toContain('page=2');
    expect(calls.find((call) => call.url.includes('/reviews/viewer'))?.cookie).toBe(
      'amzmvp_sid=x',
    );
  });

  it('is honestly empty for products without ratings and never asks guests for viewer state', async () => {
    routes['/reviews/summary'] = { body: { average: null, count: 0, distribution: null } };
    routes['/reviews'] = { body: { items: [], total: 0, page: 1, pageSize: 8 } };
    const result = await productReviews({
      productId: 'uuid-plain',
      familyIds: [],
      query: { sort: 'helpful', page: 1 },
      signedIn: false,
    });
    expect(result).toMatchObject({ summary: null, reviews: [], media: [], unavailable: false });
    expect(calls.some((call) => call.url.includes('/viewer'))).toBe(false);
  });

  it('shows nothing (and says so) when the reviews API is down', async () => {
    const result = await productReviews({
      productId: 'uuid-p1',
      familyIds: [],
      query: { sort: 'helpful', page: 1 },
      signedIn: true,
    });
    expect(result).toMatchObject({ summary: null, reviews: [], unavailable: true });
  });

  it('omits the histogram when the API has no known distribution', async () => {
    routes['/reviews/summary'] = { body: { average: 4.5, count: 10, distribution: null } };
    routes['/reviews'] = { body: { items: [], total: 0, page: 1, pageSize: 8 } };
    const result = await productReviews({
      productId: 'uuid-x',
      familyIds: [],
      query: { sort: 'helpful', page: 1 },
      signedIn: false,
    });
    expect(result.summary).toEqual({ average: 4.5, count: 10 });
  });
});
