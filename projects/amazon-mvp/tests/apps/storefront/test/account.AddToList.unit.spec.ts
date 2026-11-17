// @vitest-environment jsdom
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountAddress, CatalogItem, UserProfile } from '@amazon-mvp/api-contract';

const { push, refresh } = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh }) }));
vi.mock('../src/features/account/account-client', async (original) => ({
  ...(await original<typeof import('../src/features/account/account-client')>()),
  accountClient: {
    addresses: vi.fn(),
    deleteAddress: vi.fn(),
    setDefaultAddress: vi.fn(),
    updateAddress: vi.fn(),
    changePassword: vi.fn(),
    changeEmail: vi.fn(),
    updateName: vi.fn(),
    lists: vi.fn(),
    addToList: vi.fn(),
  },
}));

import { accountClient, AccountRequestError } from '../src/features/account/account-client';
import { listHref, stockLabel } from '../src/features/account/account-presentation';
import { AddressesManager } from '../src/features/account/addresses-manager';
import { AddToList } from '../src/features/account/add-to-list';
import { SecuritySettings } from '../src/features/account/security-settings';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const product = (overrides: Partial<CatalogItem> = {}): CatalogItem => ({
  id: 'p',
  sku: 'sku',
  slug: 'p',
  name: 'Produto',
  description: null,
  priceMinor: 1000,
  currency: 'BRL',
  active: true,
  availableQuantity: 10,
  inStock: true,
  ...overrides,
});

const address = (
  id: string,
  isDefault: boolean,
  extra: Partial<AccountAddress> = {},
): AccountAddress => ({
  id,
  recipient: `Pessoa ${id}`,
  postalCode: '90020060',
  street: `Rua ${id}`,
  number: '1',
  neighborhood: 'Centro',
  city: 'Porto Alegre',
  state: 'RS',
  isDefault,
  ...extra,
});

describe('AddToList', () => {
  it('sends guests to login instead of calling the API', () => {
    render(
      createElement(AddToList, { productId: 'p', signedIn: false, loginHref: '/login?next=x' }),
    );
    expect(screen.getByRole('link', { name: 'Adicionar à lista' }).getAttribute('href')).toBe(
      '/login?next=x',
    );
    expect(accountClient.lists).not.toHaveBeenCalled();
  });

  it('adds to the default list and links to it', async () => {
    vi.mocked(accountClient.lists).mockResolvedValue([
      { id: 'other', name: 'Outra', isDefault: false, itemCount: 0, createdAt: '' },
      { id: 'wish', name: 'Lista de desejos', isDefault: true, itemCount: 0, createdAt: '' },
    ]);
    vi.mocked(accountClient.addToList).mockResolvedValue({} as never);
    render(createElement(AddToList, { productId: 'p', signedIn: true, loginHref: '/login' }));
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar à lista' }));
    await waitFor(() =>
      expect(screen.getByRole('link', { name: 'Ver sua lista' }).getAttribute('href')).toBe(
        '/lists?list=wish',
      ),
    );
    expect(accountClient.addToList).toHaveBeenCalledWith('wish', 'p');
  });
});
