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

describe('SecuritySettings', () => {
  const user: UserProfile = {
    id: 'u',
    email: 'ada@example.com',
    displayName: 'Ada',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  const fill = (label: string, value: string) =>
    fireEvent.change(screen.getByLabelText(label), { target: { value } });

  it('never shows the password and validates the confirmation locally', () => {
    render(createElement(SecuritySettings, { user }));
    expect(screen.getByText('********')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Editar' })[2]);
    fill('Senha atual', 'current password 1');
    fill('Nova senha', 'new password 12345');
    fill('Digite a nova senha novamente', 'different password');
    fireEvent.submit(screen.getByRole('form', { name: 'Alterar sua senha' }));
    expect(screen.getByRole('alert').textContent).toContain('não coincidem');
    expect(accountClient.changePassword).not.toHaveBeenCalled();
  });

  it('reports a wrong current password without signing the user out', async () => {
    vi.mocked(accountClient.changePassword).mockRejectedValue(
      new AccountRequestError('Sua senha atual está incorreta.', 403, 'AUTH_INVALID_CREDENTIALS'),
    );
    render(createElement(SecuritySettings, { user }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Editar' })[2]);
    fill('Senha atual', 'wrong password 12');
    fill('Nova senha', 'new password 12345');
    fill('Digite a nova senha novamente', 'new password 12345');
    fireEvent.submit(screen.getByRole('form', { name: 'Alterar sua senha' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe('Sua senha atual está incorreta.'),
    );
    expect(push).not.toHaveBeenCalled();
  });

  it('reports how many other sessions were ended', async () => {
    vi.mocked(accountClient.changePassword).mockResolvedValue({
      success: true,
      revokedSessions: 2,
    });
    render(createElement(SecuritySettings, { user }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Editar' })[2]);
    fill('Senha atual', 'current password 1');
    fill('Nova senha', 'new password 12345');
    fill('Digite a nova senha novamente', 'new password 12345');
    fireEvent.submit(screen.getByRole('form', { name: 'Alterar sua senha' }));
    await waitFor(() => expect(screen.getByText(/2 outras sessões foram encerradas/)).toBeTruthy());
  });
});
