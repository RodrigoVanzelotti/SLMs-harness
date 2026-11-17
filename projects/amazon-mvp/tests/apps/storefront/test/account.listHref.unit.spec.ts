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

describe('account presentation', () => {

  it('builds list links', () => {
    expect(listHref('a b')).toBe('/lists?list=a%20b');
  });
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
