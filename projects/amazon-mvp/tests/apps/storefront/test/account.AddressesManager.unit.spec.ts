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

describe('AddressesManager', () => {
  it('marks the default and only offers "Definir como padrão" on the others', () => {
    render(
      createElement(AddressesManager, {
        initial: [address('a', true), address('b', false)],
        name: 'Ada',
      }),
    );
    expect(screen.getByText('Endereço padrão:')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /Definir como padrão/ })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Adicionar endereço' })).toBeTruthy();
  });

  it('asks for confirmation before removing and shows the server result', async () => {
    vi.mocked(accountClient.deleteAddress).mockResolvedValue([address('b', true)]);
    render(
      createElement(AddressesManager, {
        initial: [address('a', true), address('b', false)],
        name: 'Ada',
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: /Excluir endereço de Pessoa a/ }));
    expect(accountClient.deleteAddress).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Sim, excluir' }));
    await waitFor(() => expect(screen.getByText('Endereço excluído.')).toBeTruthy());
    expect(accountClient.deleteAddress).toHaveBeenCalledWith('a');
    expect(screen.queryByText('Pessoa a')).toBeNull();
  });

  it('prints the address the Amazon way, with phone only when saved', () => {
    render(
      createElement(AddressesManager, {
        initial: [
          address('a', true, { complement: 'ap 710', phone: '54996704398' }),
          address('b', false),
        ],
        name: 'Ada',
      }),
    );
    const cards = document.querySelectorAll('address');
    expect(cards[0].textContent).toContain('Rua a 1');
    expect(cards[0].textContent).toContain('ap 710 Centro');
    expect(cards[0].textContent).toContain('Porto Alegre, RS 90020060');
    expect(cards[0].textContent).toContain('Telefone: +5554996704398');
    expect(cards[1].textContent).not.toContain('Telefone');
  });

  it('saves delivery instructions with the rest of the address', async () => {
    const original = address('a', true, { phone: '54996704398' });
    vi.mocked(accountClient.updateAddress).mockResolvedValue({
      ...original,
      deliveryInstructions: 'Deixar com o porteiro',
    });
    render(createElement(AddressesManager, { initial: [original], name: 'Ada' }));
    fireEvent.click(screen.getByRole('button', { name: /Adicionar instruções de entrega/ }));
    fireEvent.change(screen.getByLabelText('Instruções de entrega'), {
      target: { value: '  Deixar com o porteiro ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(screen.getByText('Instruções de entrega salvas.')).toBeTruthy());
    const { id: _id, isDefault: _isDefault, ...input } = original;
    expect(accountClient.updateAddress).toHaveBeenCalledWith('a', {
      ...input,
      deliveryInstructions: 'Deixar com o porteiro',
    });
    expect(screen.getByText('Deixar com o porteiro')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Editar instruções de entrega/ })).toBeTruthy();
  });

  it('keeps the instructions draft open when saving fails', async () => {
    vi.mocked(accountClient.updateAddress).mockRejectedValue(new Error('Falhou.'));
    render(createElement(AddressesManager, { initial: [address('a', true)], name: 'Ada' }));
    fireEvent.click(screen.getByRole('button', { name: /Adicionar instruções de entrega/ }));
    fireEvent.change(screen.getByLabelText('Instruções de entrega'), {
      target: { value: 'Portão azul' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Falhou.'));
    expect((screen.getByLabelText('Instruções de entrega') as HTMLTextAreaElement).value).toBe(
      'Portão azul',
    );
    expect(refresh).not.toHaveBeenCalled();
  });

  it('opens the add form right away when asked (header "Cadastrar endereço")', () => {
    render(createElement(AddressesManager, { initial: [], name: 'Ada', startAdding: true }));
    expect(screen.getByRole('heading', { name: 'Adicionar um novo endereço' })).toBeTruthy();
    cleanup();

    render(createElement(AddressesManager, { initial: [], name: 'Ada' }));
    expect(screen.queryByRole('heading', { name: 'Adicionar um novo endereço' })).toBeNull();
  });

  it('refreshes the header after changing the default address', async () => {
    vi.mocked(accountClient.setDefaultAddress).mockResolvedValue([
      address('b', true),
      address('a', false),
    ]);
    render(
      createElement(AddressesManager, {
        initial: [address('a', true), address('b', false)],
        name: 'Ada',
      }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: /Definir como padrão o endereço de Pessoa b/ }),
    );
    await waitFor(() => expect(screen.getByText('Endereço padrão atualizado.')).toBeTruthy());
    expect(accountClient.setDefaultAddress).toHaveBeenCalledWith('b');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('refreshes the header after deleting the last address', async () => {
    vi.mocked(accountClient.deleteAddress).mockResolvedValue([]);
    render(createElement(AddressesManager, { initial: [address('a', true)], name: 'Ada' }));
    fireEvent.click(screen.getByRole('button', { name: /Excluir endereço de Pessoa a/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Sim, excluir' }));
    await waitFor(() => expect(screen.getByText('Endereço excluído.')).toBeTruthy());
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Você ainda não tem endereços salvos/)).toBeTruthy();
  });
});
