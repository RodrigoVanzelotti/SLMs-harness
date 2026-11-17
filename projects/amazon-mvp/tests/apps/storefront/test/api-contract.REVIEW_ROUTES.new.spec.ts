import { describe, expect, it } from 'vitest';
import { REVIEW_ROUTES } from '@amazon-mvp/api-contract';

describe('REVIEW_ROUTES', () => {
  it('lists the reviews endpoints under /api/v1', () => {
    expect(REVIEW_ROUTES.reviews).toBe('/api/v1/reviews');
    expect(REVIEW_ROUTES.summary).toBe('/api/v1/reviews/summary');
    expect(REVIEW_ROUTES.summaries).toBe('/api/v1/reviews/summaries');
    expect(REVIEW_ROUTES.viewer).toBe('/api/v1/reviews/viewer');
    expect(REVIEW_ROUTES.mine).toBe('/api/v1/reviews/mine');
  });

  it('builds the helpful-vote path with an encoded review id', () => {
    expect(REVIEW_ROUTES.helpful('3f2b8c1e-0000-4000-8000-000000000001')).toBe(
      '/api/v1/reviews/3f2b8c1e-0000-4000-8000-000000000001/helpful',
    );
    expect(REVIEW_ROUTES.helpful('a b/c?d')).toBe('/api/v1/reviews/a%20b%2Fc%3Fd/helpful');
  });
});
