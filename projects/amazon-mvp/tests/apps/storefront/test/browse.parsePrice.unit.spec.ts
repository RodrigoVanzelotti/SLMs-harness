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

  it('parses price ranges in minor units, open-ended or bounded', () => {
    expect(parsePrice('200000-')).toEqual({ min: 200000, max: null });
    expect(parsePrice('0-5000')).toEqual({ min: 0, max: 5000 });
    expect(parsePrice('5000-5000')).toBeNull();
    expect(parsePrice('9000-5000')).toBeNull();
    expect(parsePrice('-5000')).toBeNull();
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
