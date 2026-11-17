// @vitest-environment jsdom
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { FeatureRegistry, readYamlFile } from '@amazon-mvp/config-schema';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AmazonFooter } from '../src/components/amazon/amazon-footer';
import { HELP_CATEGORIES } from '../src/features/help/help-content';
import { CONDITIONS_OF_USE } from '../src/features/legal/conditions-of-use-content';
import { LegalArticle } from '../src/features/legal/legal-article';
import { legalPageMetadata } from '../src/features/legal/legal-page';
import type { LegalDocument, RichText } from '../src/features/legal/legal-types';
import { PRIVACY_NOTICE } from '../src/features/legal/privacy-notice-content';

vi.mock('server-only', () => ({}));
vi.mock('next/font/local', () => ({ default: () => ({ variable: 'font-legal', className: '' }) }));
vi.mock('../src/components/amazon/amazon-header', () => ({ AmazonHeader: () => null }));

afterEach(cleanup);

const SRC = join(process.cwd(), 'src');
const APP = join(SRC, 'app');
const REPO_FEATURES = join(process.cwd(), '..', '..', 'config', 'features.yaml');

const DOCS: Array<[flag: string, doc: LegalDocument]> = [
  ['privacyNotice', PRIVACY_NOTICE],
  ['conditionsOfUse', CONDITIONS_OF_USE],
];

const hrefs = (text: RichText): string[] =>
  typeof text === 'string'
    ? []
    : text.flatMap((part) => (typeof part === 'string' ? [] : [part.href]));

const docHrefs = (doc: LegalDocument) => [
  ...doc.intro.flatMap(hrefs),
  ...doc.sections.flatMap((section) =>
    section.blocks.flatMap((block) => {
      if (block.kind === 'text') return hrefs(block.body);
      if (block.kind === 'list') return block.items.flatMap((item) => hrefs(item.body));
      return [];
    }),
  ),
];

const anchorIds = (doc: LegalDocument) =>
  new Set(
    doc.sections.flatMap((section) => [
      section.id,
      ...section.blocks.flatMap((block) =>
        block.kind === 'subheading' && block.id ? [block.id] : [],
      ),
    ]),
  );

describe.each(DOCS)('%s', (flag, doc) => {
  it('is enabled in the shipped config and served by its own route', () => {
    const registry = FeatureRegistry.fromConfig(readYamlFile(REPO_FEATURES));
    expect(registry.isEnabled(flag)).toBe(true);
    expect(registry.routeState(flag)).toBe('enabled');
    const page = readFileSync(join(APP, doc.href.slice(1), 'page.tsx'), 'utf8');
    expect(page).toContain(`routeKey="${flag}"`);
  });
});
