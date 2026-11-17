// @vitest-environment jsdom
import { createElement } from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogProductDetails, OrderResponse } from '@amazon-mvp/api-contract';

vi.mock('server-only', () => ({}));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  cache: (fn: unknown) => fn,
}));
const { notFound, flags, session, fetchOrders, pricing, savedCards, requestCookies } = vi.hoisted(() => ({
  savedCards: vi.fn(),
  requestCookies: {} as Record<string, string>,
  pricing: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  flags: {} as Record<string, boolean>,
  session: vi.fn(),
  fetchOrders: vi.fn(),
}));
vi.mock('next/headers', () => ({
  cookies: () => ({
    toString: () => 'amzmvp_sid=x',
    get: (name: string) =>
      name in requestCookies ? { name, value: requestCookies[name] } : undefined,
  }),
}));
vi.mock('next/navigation', () => ({
  notFound,
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('next/image', () => ({
  default: ({ priority: _p, sizes: _s, ...props }: Record<string, unknown>) =>
    createElement('img', props),
}));
vi.mock('../src/config/feature-gate', () => ({
  isFeatureEnabled: (feature: string) => flags[feature] ?? false,
  FeatureRoute: ({ title }: { title: string }) => createElement('p', null, `coming soon: ${title}`),
}));
vi.mock('../src/config/storefront-config', () => ({
  getConfig: () => ({ api: { internalBaseUrl: 'http://api', publicBasePath: '/api/v1' } }),
}));
vi.mock('../src/features/auth/server-session', () => ({ getServerSession: () => session() }));
vi.mock('../src/features/orders/orders-server', () => ({ fetchOrders: () => fetchOrders() }));
vi.mock('../src/features/cart/cart-provider', () => ({
  useCart: () => ({
    cart: null,
    status: 'ready',
    pending: false,
    error: null,
    notice: '',
    refresh: vi.fn(),
    add: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    clear: vi.fn(),
  }),
}));

import ProductDetailPage, { generateMetadata } from '../src/app/products/[productId]/page';

const games = [
  { slug: 'games-e-consoles', name: 'Games e Consoles' },
  { slug: 'games-pc', name: 'PC' },
  { slug: 'games-pc-acessorios', name: 'Acessórios' },
  { slug: 'games-pc-controles', name: 'Controles e Gamepads' },
];
const echo = [
  { slug: 'dispositivos-amazon', name: 'Dispositivos Amazon' },
  { slug: 'echo-e-alexa', name: 'Echo e Alexa' },
  { slug: 'echo-smart-speakers', name: 'Smart Speakers' },
];
const record = (
  slug: string,
  name: string,
  priceMinor: number,
  categoryPath: CatalogProductDetails['categoryPath'],
  extra: Partial<CatalogProductDetails> = {},
): CatalogProductDetails => ({
  id: `uuid-${slug}`,
  slug,
  sku: slug.startsWith('p') ? `DEMO-${slug}` : slug.toUpperCase(),
  name,
  description: null,
  priceMinor,
  currency: 'BRL',
  active: true,
  availableQuantity: 10,
  inStock: true,
  categories: categoryPath.slice(-1),
  categoryPath,
  ...extra,
});
const CATALOG = [
  record('p6', '8BitDo Ultimate 2C (Mint)', 20520, games, {
    description: 'Qualidade 8BitDo em controles e gamepads para consoles.',
  }),
  record('p21', '8BitDo Ultimate 2C (Peach)', 21000, games),
  record('p22', '8BitDo Ultimate 2C (Purple)', 19950, games),
  record('p23', 'Controle 8BitDo Ultimate 2C, Verde', 20010, games, {
    inStock: false,
    availableQuantity: 0,
  }),
  record('p1', 'Echo Dot (5ª geração) com Alexa, Preto', 27900, echo),
  record('p18', 'Echo Show 5, Tela Inteligente com Alexa', 39900, [
    ...echo.slice(0, 2),
    { slug: 'echo-smart-displays', name: 'Smart Displays' },
  ]),
  record('plain-mug', 'Plain mug', 1990, [{ slug: 'kitchen', name: 'Kitchen' }]),
];

const EMPTY = { average: null, count: 0 };
const RATINGS: Record<string, { average: number; count: number }> = {
  'uuid-p6': { average: 4.8, count: 5512 },
  'uuid-p1': { average: 4.7, count: 48213 },
  'uuid-p18': { average: 4.6, count: 9123 },
};
const REVIEWS = ['uuid-p6', 'uuid-p21', 'uuid-p22', 'uuid-p23'].map((productId, index) => ({
  id: `r${index}`,
  productId,
  authorName: `Autor ${index}`,
  rating: 5,
  title: `Título ${index}`,
  body: 'Texto da avaliação.',
  verifiedPurchase: index < 2,
  helpfulCount: 4 - index,
  createdAt: '2026-08-01T12:00:00.000Z',
  updatedAt: '2026-08-01T12:00:00.000Z',
}));

beforeEach(() => {
  Object.assign(flags, {
    productDetails: true,
    cart: true,
    checkout: true,
    orders: true,
    catalog: false,
  });
  session.mockReset().mockResolvedValue(null);
  fetchOrders.mockReset().mockResolvedValue([]);
  savedCards.mockReset().mockReturnValue(null);
  for (const name of Object.keys(requestCookies)) delete requestCookies[name];
  pricing
    .mockReset()
    .mockImplementation(
      () => ({ ok: true, status: 200, json: async () => ({ pixDiscountPercent: 5 }) }) as Response,
    );
  notFound.mockClear();
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const json = (body: unknown, status = 200) =>
        ({ ok: status < 400, status, json: async () => body }) as Response;
      const path = url.replace('http://api/api/v1', '');
      if (path === '/addresses') return json([]);
      if (path === '/orders/pricing') return pricing();
      if (path === '/payment-cards') {
        const cards: unknown = savedCards();
        return cards ? json(cards) : json({ error: {} }, 503);
      }
      const reviewIds = (path.match(/productIds=([^&]+)/)?.[1] ?? '').split(',');
      if (path.startsWith('/reviews/summaries'))
        return json({
          items: reviewIds.map((id) => ({ productId: id, ...(RATINGS[id] ?? EMPTY) })),
        });
      if (path.startsWith('/reviews/summary')) {
        const rated = reviewIds.map((id) => RATINGS[id]).find(Boolean);
        return json(
          rated && reviewIds.includes('uuid-p6')
            ? { ...rated, distribution: [92, 5, 1, 0, 2].map((percent, i) => ({ stars: 5 - i, percent })) }
            : { ...(rated ?? EMPTY), distribution: null },
        );
      }
      if (path.startsWith('/reviews/viewer')) return json({ ownReviews: [], helpfulReviewIds: [] });
      if (path.startsWith('/reviews?')) {
        const items = REVIEWS.filter((review) => reviewIds.includes(review.productId));
        return json({ items, total: items.length, page: 1, pageSize: 8 });
      }
      const list = path.match(/^\/catalog\/products\?.*category=([^&]+)/);
      if (list)
        return json({
          items: CATALOG.filter((p) => p.categoryPath.some((c) => c.slug === list[1])),
          total: 0,
        });
      const id = decodeURIComponent(path.replace('/catalog/products/', ''));
      const found = CATALOG.find((p) => p.slug === id || p.id === id);
      return found ? json(found) : json({ error: {} }, 404);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const renderPage = async (productId: string) =>
  render(await ProductDetailPage({ params: { productId } }));

const order = (placedAt: string, productId: string): OrderResponse => ({
  id: 'order-1',
  orderNumber: '702-1',
  status: 'FULFILLED',
  subtotalMinor: 0,
  shippingMinor: 0,
  discountMinor: 0,
  totalMinor: 0,
  currency: 'BRL',
  shippingAddress: null,
  paymentMethod: null,
  paymentCard: null,
  installments: null,
  placedAt,
  deliveredAt: null,
  deliveryNote: null,
  lines: [
    {
      productId,
      productName: 'x',
      sku: 'x',
      quantity: 1,
      unitPriceMinor: 0,
      lineTotalMinor: 0,
      currency: 'BRL',
    },
  ],
});

describe('product detail page', () => {

  it('builds metadata from the product', async () => {
    expect(await generateMetadata({ params: { productId: 'p6' } })).toMatchObject({
      title: '8BitDo Ultimate 2C (Mint) | Amazon.com.br',
      description: 'Qualidade 8BitDo em controles e gamepads para consoles.',
      openGraph: { images: [{ url: '/images/products/8bitdo-ultimate-2c/hortela-1.jpg' }] },
    });
    // Without a description, the page falls back to the name, never another product's text.
    expect((await generateMetadata({ params: { productId: 'p1' } })).description).toBe(
      'Echo Dot (5ª geração) com Alexa, Preto',
    );
    expect((await generateMetadata({ params: { productId: 'nope' } })).title).toBe(
      'Produto não encontrado | Amazon.com.br',
    );
  });
});
