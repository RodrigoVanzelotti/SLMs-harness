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

describe('corporate page template', () => {
  it.each(CORPORATE_PAGES.map((page) => [page.key, page] as const))(
    'renders %s with one h1, its sections and the group navigation',
    (_key, page) => {
      render(createElement(CorporateBody, { page }));

      const h1s = screen.getAllByRole('heading', { level: 1 });
      expect(h1s.map((h) => h.textContent)).toEqual([page.hero.title]);
      expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(
        page.blocks.map((block) => block.title),
      );
      expect(screen.getByRole('main')).toBeTruthy();

      const group = CORPORATE_GROUPS.find((g) => g.id === page.group)!;
      const nav = screen.getByRole('navigation', { name: group.label });
      const current = nav.querySelectorAll('[aria-current="page"]');
      expect(current).toHaveLength(1);
      expect(current[0].getAttribute('href')).toBe(page.href);
      expect(within(nav).getAllByRole('link')).toHaveLength(group.links.length);

      const faqs = page.blocks.flatMap((block) => (block.kind === 'faq' ? block.items : []));
      const details = Array.from(document.querySelectorAll('details'));
      expect(details.map((item) => item.querySelector('summary')?.textContent)).toEqual(
        faqs.map((item) => item.question),
      );
      expect(details.every((item) => !item.open)).toBe(true);

      for (const block of page.blocks) {
        if (block.kind === 'notice') expect(screen.getByText(block.message)).toBeTruthy();
        if (block.kind === 'cards') {
          for (const card of block.cards) {
            expect(screen.getAllByRole('heading', { level: 3, name: card.title }).length).toBeGreaterThan(0);
          }
        }
      }

      for (const link of screen.getAllByRole('link')) {
        const href = link.getAttribute('href') ?? '';
        expect(href.startsWith('/') || href.startsWith('#')).toBe(true);
      }
      expect(document.body.textContent).toContain('projeto acadêmico');
    },
  );
});
