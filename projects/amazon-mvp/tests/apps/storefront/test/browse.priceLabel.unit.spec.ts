import { describe, expect, it } from 'vitest';
import type { CatalogCategoryNode } from '@amazon-mvp/api-contract';
import {
  brandHref,
  brandKey,
  browseHref,
  categoryHref,
  EMPTY_BROWSE,
  parseBrowseParams,
  parsePrice,
  priceLabel,
} from '../src/features/browse/browse-params';
import {
  brandFacet,
  buildCategoryTree,
  categoryTrail,
  departmentFacet,
  listingTitle,
  pageWindow,
  resultsSummary,
} from '../src/features/browse/browse-model';

describe('listing URL parameters', () => {

  it('labels price buckets in reais', () => {
    expect(priceLabel({ min: 0, max: 5000 })).toMatch(/^Até R\$\s50$/);
    expect(priceLabel({ min: 5000, max: 10000 })).toMatch(/^R\$\s50 a R\$\s100$/);
    expect(priceLabel({ min: 200000, max: null })).toMatch(/^R\$\s2\.000 ou mais$/);
    expect(priceLabel({ min: 4990, max: null })).toMatch(/^R\$\s49,90 ou mais$/);
  });
});

const NODES: CatalogCategoryNode[] = [
  { slug: 'eletronicos', name: 'Eletrônicos', parentSlug: null },
  { slug: 'audio', name: 'Áudio', parentSlug: 'eletronicos' },
  { slug: 'fones', name: 'Fones de Ouvido', parentSlug: 'audio' },
  { slug: 'wearables', name: 'Wearables', parentSlug: 'eletronicos' },
  { slug: 'livros', name: 'Livros', parentSlug: null },
  { slug: 'orphan', name: 'Órfã', parentSlug: 'missing' },
];
