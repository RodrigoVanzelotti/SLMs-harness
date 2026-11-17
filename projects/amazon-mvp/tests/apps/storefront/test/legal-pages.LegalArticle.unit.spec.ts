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

  it('renders one h1 and a table of contents for every section', () => {
    render(createElement(LegalArticle, { doc }));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(doc.title);
    const links = within(screen.getByRole('navigation', { name: 'Nesta página' })).getAllByRole(
      'link',
    );
    expect(links.map((a) => a.getAttribute('href'))).toEqual(doc.sections.map((s) => `#${s.id}`));
    for (const section of doc.sections) {
      expect(document.getElementById(section.id)).not.toBeNull();
    }
    expect(new Set(doc.sections.map((s) => s.id)).size).toBe(doc.sections.length);
  });

  it('marks itself as the current page in the "Políticas legais" sidebar', () => {
    render(createElement(LegalArticle, { doc }));
    const nav = within(screen.getByRole('navigation', { name: 'Políticas legais' }));
    const current = nav.getByRole('link', { current: 'page' });
    expect(current.getAttribute('href')).toBe(doc.href);
    expect(nav.getAllByRole('link')).toHaveLength(2);
    expect(
      screen.getByRole('link', { name: /Todos os tópicos da Ajuda/ }).getAttribute('href'),
    ).toBe('/help');
  });
});

it('shows the privacy notice update date and the conditions without one', () => {
  render(createElement(LegalArticle, { doc: PRIVACY_NOTICE }));
  expect(screen.getByText('Última atualização: 25 de setembro de 2025')).toBeTruthy();
  cleanup();
  render(createElement(LegalArticle, { doc: CONDITIONS_OF_USE }));
  expect(screen.queryByText(/Última atualização/)).toBeNull();
});

it('searches the help library from "Encontrar mais soluções"', () => {
  render(createElement(LegalArticle, { doc: CONDITIONS_OF_USE }));
  fireEvent.change(screen.getByLabelText('Encontrar mais soluções'), {
    target: { value: 'endereços' },
  });
  const results = within(screen.getByRole('list', { name: 'Resultados da pesquisa' }));
  expect(results.getByRole('link', { name: 'Gerenciar endereços' }).getAttribute('href')).toBe(
    '/addresses',
  );
});
