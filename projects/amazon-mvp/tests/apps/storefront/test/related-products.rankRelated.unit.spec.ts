import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogItem, CatalogProductDetails } from '@amazon-mvp/api-contract';

vi.mock('server-only', () => ({}));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  cache: (fn: unknown) => fn,
}));
vi.mock('next/headers', () => ({ cookies: () => ({ toString: () => '' }) }));
vi.mock('../src/config/storefront-config', () => ({
  getConfig: () => ({ api: { internalBaseUrl: 'http://api', publicBasePath: '/api/v1' } }),
}));

import { rankRelated, type RelatedCandidate } from '../src/features/product/related-products';
import { relatedProducts } from '../src/features/product/product-server';
import demos from '../../../config/demo-products.json';
import contents from '../../../config/demo-product-content.json';
import categories from '../../../config/demo-categories.json';

const item = (id: string, priceMinor = 10000, extra: Partial<CatalogItem> = {}): CatalogItem => ({
  id,
  slug: id,
  sku: `SKU-${id}`,
  name: id,
  description: null,
  priceMinor,
  currency: 'BRL',
  active: true,
  availableQuantity: 5,
  inStock: true,
  ...extra,
});
const candidate = (
  id: string,
  distance: number,
  facts: Partial<RelatedCandidate['facts']> = {},
  extra: Partial<CatalogItem> = {},
): RelatedCandidate => ({
  item: item(id, extra.priceMinor, extra),
  distance,
  facts: { attributes: [], ...facts },
});

describe('rankRelated', () => {
  const target = { item: item('shoe', 30000), facts: { brand: 'A', attributes: [] } };

  it('prefers the closest category, then brand, then similar price', () => {
    const ranked = rankRelated(
      target,
      [
        candidate('parent-same-brand', 1, { brand: 'A' }, { priceMinor: 30000 }),
        candidate('leaf-cheap', 0, {}, { priceMinor: 2000 }),
        candidate('leaf-same-brand', 0, { brand: 'A' }, { priceMinor: 90000 }),
        candidate('leaf-similar-price', 0, {}, { priceMinor: 31000 }),
      ],
      10,
    );
    expect(ranked.map((p) => p.id)).toEqual([
      'leaf-same-brand',
      'leaf-similar-price',
      'leaf-cheap',
      'parent-same-brand',
    ]);
  });

  it('never returns the product itself, its family, duplicates or inactive records', () => {
    const own = { item: item('p1'), facts: { family: 'fam', attributes: [] } };
    const ranked = rankRelated(
      own,
      [
        candidate('p1', 0),
        candidate('sibling', 0, { family: 'fam' }),
        candidate('other', 0),
        candidate('other', 1),
        candidate('inactive', 0, {}, { active: false }),
      ],
      10,
    );
    expect(ranked.map((p) => p.id)).toEqual(['other']);
  });

  it('shows one card per other family, preferring the member that shares attributes', () => {
    const black = { label: 'Cor', value: 'Preto' };
    const ranked = rankRelated(
      { item: item('mine'), facts: { attributes: [black] } },
      [
        candidate('run-white', 0, {
          family: 'run',
          attributes: [{ label: 'Cor', value: 'Branco' }],
        }),
        candidate('run-black', 0, { family: 'run', attributes: [black] }),
        candidate('single', 0),
      ],
      10,
    );
    expect(ranked.map((p) => p.id)).toEqual(['run-black', 'single']);
  });

  it('ranks candidates sharing more of the product categories first', () => {
    const ranked = rankRelated(
      target,
      [
        candidate('gamer-keyboard', 0, { brand: 'A' }),
        { ...candidate('other-headset', 0), sharedCategories: 2 },
      ],
      10,
    );
    expect(ranked.map((p) => p.id)).toEqual(['other-headset', 'gamer-keyboard']);
  });

  it('represents a family by its head when no attribute is shared', () => {
    const ranked = rankRelated(
      target,
      [
        candidate('fam-branco', 0, { family: 'fam' }),
        candidate('fam-preto', 0, { family: 'fam', familyHead: true }),
      ],
      10,
    );
    expect(ranked.map((p) => p.id)).toEqual(['fam-preto']);
  });

  it('puts sold-out products after available ones and honours the limit', () => {
    const ranked = rankRelated(
      target,
      [
        candidate('sold-out', 0, { brand: 'A' }, { inStock: false, availableQuantity: 0 }),
        ...['a', 'b', 'c'].map((id) => candidate(id, 0)),
      ],
      3,
    );
    expect(ranked).toHaveLength(3);
    expect(ranked.map((p) => p.id)).not.toContain('sold-out');
  });
});

// ---------------------------------------------------------------------------
// The real demo catalog behind a fake API: category lists include the subtree
// and are capped like the real endpoint, so this exercises the same requests
// the product page makes.

type Content = { id: string; sku: string; categories?: string[]; variant?: { group: string } };
const parent = new Map(
  (categories as Array<{ slug: string; name: string; parent?: string }>).map((c) => [c.slug, c]),
);
const pathOf = (slug: string) => {
  const chain: Array<{ slug: string; name: string }> = [];
  for (let current = parent.get(slug); current; current = parent.get(current.parent ?? ''))
    chain.unshift({ slug: current.slug, name: current.name });
  return chain;
};
const categoriesOf = new Map((contents as Content[]).map((c) => [c.id, c.categories ?? []]));
const categoryOf = new Map([...categoriesOf].map(([id, slugs]) => [id, slugs[0]]));
const familyOf = new Map((contents as Content[]).map((c) => [c.id, c.variant?.group]));
// Like the API: every linked category is listed; the deepest chain is the breadcrumb.
const CATALOG: CatalogProductDetails[] = demos.map((demo) => ({
  ...item(`uuid-${demo.id}`, demo.priceMinor, {
    slug: demo.id,
    sku: demo.sku,
    name: demo.name,
    availableQuantity: demo.inventoryQuantity,
    inStock: demo.inventoryQuantity > 0,
  }),
  categories: categoriesOf.get(demo.id)!.map((slug) => ({ slug, name: '' })),
  categoryPath: categoriesOf
    .get(demo.id)!
    .map(pathOf)
    .reduce((deepest, path) => (path.length > deepest.length ? path : deepest), []),
}));
const inSubtree = (product: CatalogProductDetails, slug: string) =>
  product.categories.some((category) => pathOf(category.slug).some((c) => c.slug === slug));
const rootsOf = (product: CatalogItem) =>
  categoriesOf.get(product.slug)!.map((slug) => pathOf(slug)[0].slug);

let requests: string[] = [];
beforeEach(() => {
  requests = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      requests.push(url);
      const query = new URL(url).searchParams;
      const slug = query.get('category')!;
      const items = CATALOG.filter((product) => inSubtree(product, slug))
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, Number(query.get('pageSize')));
      return { ok: true, status: 200, json: async () => ({ items, total: items.length }) };
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const bySlug = (slug: string) => CATALOG.find((product) => product.slug === slug)!;
const recommend = (slug: string) => {
  const product = bySlug(slug);
  const family = familyOf.get(slug);
  const exclude = new Set(
    CATALOG.filter((p) => p.id === product.id || (family && familyOf.get(p.slug) === family)).map(
      (p) => p.id,
    ),
  );
  return relatedProducts(product, exclude);
};
const leafOf = (product: CatalogItem) => categoryOf.get(product.slug)!;
