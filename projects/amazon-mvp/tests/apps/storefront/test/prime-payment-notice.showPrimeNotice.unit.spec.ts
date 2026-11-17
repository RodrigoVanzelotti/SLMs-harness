// @vitest-environment jsdom
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SavedPaymentCard } from '@amazon-mvp/api-contract';

const { refresh, client } = vi.hoisted(() => ({
  refresh: vi.fn(),
  client: { cards: vi.fn(), saveCard: vi.fn(), deleteCard: vi.fn() },
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
vi.mock('../src/features/checkout/checkout-client', () => ({ checkoutClient: client }));

import { PrimePaymentNotice } from '../src/features/product/prime-payment-notice';
import { showPrimeNotice } from '../src/features/product/product-rules';

const card = (id: string, expYear: number): SavedPaymentCard => ({
  id,
  brand: 'VISA',
  last4: '4242',
  holderName: 'Ana Souza',
  expMonth: 1,
  expYear,
});
const BANNER = /Sua assinatura Prime está pausada/;
const renderNotice = () =>
  render(createElement(PrimePaymentNotice, { userId: 'user-1', userName: 'Ana Souza' }));

beforeEach(() => {
  refresh.mockReset();
  client.cards.mockReset().mockResolvedValue([]);
  client.saveCard.mockReset();
  client.deleteCard.mockReset();
  document.cookie = 'az_prime_notice_dismissed=; Max-Age=0; Path=/';
});
afterEach(cleanup);

describe('showPrimeNotice', () => {
  const now = new Date('2026-10-02T12:00:00Z');
  it('needs a non-expired card or a dismissal by this user to go away', () => {
    expect(showPrimeNotice(null, undefined, 'u', now)).toBe(true);
    expect(showPrimeNotice([], undefined, 'u', now)).toBe(true);
    expect(showPrimeNotice([card('a', 2025)], undefined, 'u', now)).toBe(true);
    expect(showPrimeNotice([card('a', 2025), card('b', 2027)], undefined, 'u', now)).toBe(false);
    expect(showPrimeNotice([], 'u', 'u', now)).toBe(false);
    expect(showPrimeNotice([], 'other', 'u', now)).toBe(true);
  });
});
