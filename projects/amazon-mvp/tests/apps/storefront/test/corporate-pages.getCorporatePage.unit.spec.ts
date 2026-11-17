// @vitest-environment jsdom
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createElement, type ComponentType } from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import { FeatureRegistry, readYamlFile } from '@amazon-mvp/config-schema';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CorporateBody } from '../src/features/corporate/corporate-body';
import { CORPORATE_PAGES, getCorporatePage } from '../src/features/corporate/corporate-content';
import { ICONS } from '../src/features/corporate/corporate-icons';
import { CORPORATE_GROUPS, CORPORATE_ROUTES } from '../src/features/corporate/corporate-routes';
import type { CorporateAction, CorporatePage } from '../src/features/corporate/corporate-types';

const REPO_FEATURES = join(process.cwd(), '..', '..', 'config', 'features.yaml');
const APP_DIR = join(process.cwd(), 'src', 'app');
const loadShipped = () => FeatureRegistry.fromConfig(readYamlFile(REPO_FEATURES));

// The page modules resolve flags through the real registry (config/features.yaml),
// swapped per test when a disabled flag must be simulated.
const flags = vi.hoisted(() => ({ registry: null as null | { routeState(key: string): string; isEnabled(feature: string): boolean } }));

vi.mock('server-only', () => ({}));
vi.mock('next/font/local', () => ({ default: () => ({ variable: 'font-corp', className: '' }) }));
vi.mock('../src/components/amazon/amazon-header', () => ({ AmazonHeader: () => null }));
vi.mock('../src/config/storefront-config', () => ({ getFeatureRegistry: () => flags.registry }));

beforeEach(() => {
  flags.registry = loadShipped();
});
afterEach(cleanup);

const ROUTE_DIRS: Record<string, string> = {
  about: 'about',
  corporateInformation: 'corporate-information',
  careers: 'careers',
  press: 'press',
  community: 'community',
  accessibility: 'accessibility',
  amazonScience: 'amazon-science',
  brandProtection: 'brand-protection',
  supply: 'supply',
  publish: 'publish',
  associates: 'associates',
  advertise: 'advertise',
};

const FOOTER_ORDER = Object.keys(ROUTE_DIRS);

const loadPage = async (key: string) =>
  (await import(`../src/app/${ROUTE_DIRS[key]}/page.tsx`)) as {
    default: ComponentType;
    generateMetadata: () => { title?: string; description?: string };
  };

function actionsOf(page: CorporatePage): CorporateAction[] {
  const actions: CorporateAction[] = [...(page.hero.actions ?? [])];
  for (const block of page.blocks) {
    if (block.kind === 'cta') actions.push(...block.actions);
    if ((block.kind === 'split' || block.kind === 'notice') && block.action) actions.push(block.action);
    if (block.kind === 'cards') for (const card of block.cards) if (card.action) actions.push(card.action);
  }
  return actions;
}

function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
  return [];
}

describe('corporate content data', () => {

  it('uses honest notices where the real pages list records', () => {
    const notice = (key: Parameters<typeof getCorporatePage>[0]) =>
      getCorporatePage(key).blocks.find((block) => block.kind === 'notice');
    expect(notice('press')).toMatchObject({ message: 'Nenhum comunicado publicado nesta loja acadêmica.' });
    expect(notice('careers')).toMatchObject({ message: 'Não há vagas abertas nesta demonstração.' });
    for (const key of ['corporateInformation', 'community', 'amazonScience', 'supply', 'publish', 'associates', 'advertise'] as const) {
      expect(notice(key)).toBeDefined();
    }
  });
});

describe('corporate page template', () => {

  it('renders the comparison as an accessible table', () => {
    render(createElement(CorporateBody, { page: getCorporatePage('supply') }));
    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('columnheader').map((th) => th.textContent)).toEqual([
      'Fornecedor (1P)',
      'Vendedor parceiro (3P)',
    ]);
    expect(within(table).getAllByRole('rowheader')).toHaveLength(5);
  });
});
