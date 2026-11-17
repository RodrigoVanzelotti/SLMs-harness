import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkoutClient, CheckoutError } from '../src/features/checkout/checkout-client';

const realFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const apiError = (status: number, code: string, message: string, details?: unknown) =>
  json(status, { error: { code, message, requestId: 'req-1', ...(details ? { details } : {}) } });

const ADDRESS = {
  recipient: 'Pessoa Teste',
  postalCode: '01001000',
  street: 'Rua Exemplo',
  number: '10',
  neighborhood: 'Centro',
  city: 'São Paulo',
  state: 'SP',
};

beforeEach(() => {
  fetchMock = vi.fn(async () => json(200, []));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

function lastCall(): { url: string; init: RequestInit } {
  const [url, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
  return { url, init };
}

async function failure(promise: Promise<unknown>): Promise<CheckoutError> {
  try {
    await promise;
  } catch (error) {
    return error as CheckoutError;
  }
  throw new Error('expected the request to fail');
}

describe('checkoutClient requests', () => {
  it('reads addresses and cards with same-origin, uncached GETs', async () => {
    expect(await checkoutClient.addresses()).toEqual([]);
    expect(lastCall().url).toBe('/api/v1/addresses');
    expect(lastCall().init.method).toBe('GET');
    expect(lastCall().init.credentials).toBe('same-origin');
    expect(lastCall().init.cache).toBe('no-store');
    expect(lastCall().init.headers).toBeUndefined();
    expect(lastCall().init.body).toBeUndefined();

    await checkoutClient.cards();
    expect(lastCall().url).toBe('/api/v1/payment-cards');
    expect(lastCall().init.method).toBe('GET');
  });

  it('creates an address with POST and updates one with PUT on its encoded id', async () => {
    await checkoutClient.saveAddress(ADDRESS);
    expect(lastCall().url).toBe('/api/v1/addresses');
    expect(lastCall().init.method).toBe('POST');
    expect(lastCall().init.headers).toEqual({ 'content-type': 'application/json' });
    expect(lastCall().init.body).toBe(JSON.stringify(ADDRESS));

    await checkoutClient.saveAddress(ADDRESS, 'id 1');
    expect(lastCall().url).toBe('/api/v1/addresses/id%201');
    expect(lastCall().init.method).toBe('PUT');
    expect(lastCall().init.body).toBe(JSON.stringify(ADDRESS));
  });

  it('saves a card with POST and deletes one with a bodiless DELETE', async () => {
    const card = { brand: 'VISA' as const, last4: '1111', holderName: 'Pessoa Teste', expMonth: 1, expYear: 2099 };
    await checkoutClient.saveCard(card);
    expect(lastCall().url).toBe('/api/v1/payment-cards');
    expect(lastCall().init.method).toBe('POST');
    expect(lastCall().init.body).toBe(JSON.stringify(card));

    await checkoutClient.deleteCard('a/b');
    expect(lastCall().url).toBe('/api/v1/payment-cards/a%2Fb');
    expect(lastCall().init.method).toBe('DELETE');
    expect(lastCall().init.headers).toBeUndefined();
    expect(lastCall().init.body).toBeUndefined();
  });

  it('quotes with an optional payment method query', async () => {
    await checkoutClient.quote();
    expect(lastCall().url).toBe('/api/v1/orders/quote');
    expect(lastCall().init.method).toBe('GET');
    await checkoutClient.quote('SIMULATED_PIX');
    expect(lastCall().url).toBe('/api/v1/orders/quote?paymentMethod=SIMULATED_PIX');
  });

  it('places an order with a JSON POST and returns the order', async () => {
    fetchMock.mockImplementation(async () => json(201, { id: 'order-1' }));
    const request = { cartId: 'cart', revision: 'rev', addressId: 'address', paymentMethod: 'SIMULATED_PIX' as const };
    expect(await checkoutClient.place(request)).toEqual({ id: 'order-1' });
    expect(lastCall().url).toBe('/api/v1/orders');
    expect(lastCall().init.method).toBe('POST');
    expect(lastCall().init.headers).toEqual({ 'content-type': 'application/json' });
    expect(lastCall().init.body).toBe(JSON.stringify(request));
  });
});

describe('checkoutClient errors', () => {
  it('uses the API message and keeps the status', async () => {
    fetchMock.mockImplementation(async () => apiError(409, 'CONFLICT', 'O carrinho mudou.'));
    const error = await failure(checkoutClient.quote());
    expect(error).toBeInstanceOf(CheckoutError);
    expect(error.message).toBe('O carrinho mudou.');
    expect(error.status).toBe(409);
  });

  it('replaces validation details with a generic field message', async () => {
    fetchMock.mockImplementation(async () =>
      apiError(400, 'VALIDATION_FAILED', 'Invalid', [{ field: 'postalCode', message: 'bad' }]),
    );
    const error = await failure(checkoutClient.saveAddress(ADDRESS));
    expect(error.message).toBe('Confira os campos obrigatórios e seus formatos.');
    expect(error.status).toBe(400);
  });

  it('keeps the API message when details are empty', async () => {
    fetchMock.mockImplementation(async () => apiError(400, 'VALIDATION_FAILED', 'Revise o pedido.', []));
    const error = await failure(checkoutClient.place({ cartId: 'c', revision: 'r', addressId: 'a', paymentMethod: 'SIMULATED_PIX' }));
    expect(error.message).toBe('Revise o pedido.');
  });

  it('falls back to a generic message for bodies that are not API errors', async () => {
    fetchMock.mockImplementation(async () => new Response('Bad gateway', { status: 502 }));
    const error = await failure(checkoutClient.cards());
    expect(error).toBeInstanceOf(CheckoutError);
    expect(error.message).toBe('Não foi possível completar a solicitação.');
    expect(error.status).toBe(502);
  });
});
