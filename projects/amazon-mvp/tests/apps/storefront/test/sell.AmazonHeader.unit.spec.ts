// @vitest-environment jsdom
import { createElement } from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SellLanding } from '../src/features/sell/sell-landing';
import { FAQ, SELL_LINKS } from '../src/features/sell/sell-content';
import { AmazonHeader } from '../src/components/amazon/amazon-header';

vi.mock('server-only', () => ({}));
vi.mock('../src/config/feature-gate', () => ({ isFeatureEnabled: () => false }));
vi.mock('../src/features/auth/server-session', () => ({ getServerSession: async () => null }));
vi.mock('../src/features/account/account-server', () => ({ fetchAddresses: async () => [] }));
vi.mock('../src/features/cart/cart-header-link',() => ({ CartHeaderLink: () => null }));
vi.mock('../src/components/amazon/account-menu', () => ({ AccountMenu: () => null }));

afterEach(cleanup);

const renderLanding = () => render(createElement(SellLanding));

it('marks "Venda na Amazon" as the current header item', async () => {
  render(await AmazonHeader({ currentHref: '/sell' }));
  const nav = screen.getByRole('navigation', { name: 'Categorias' });
  const current = nav.querySelectorAll('[aria-current="page"]');
  expect(current).toHaveLength(1);
  expect(current[0].textContent).toBe('Venda na Amazon');
});
