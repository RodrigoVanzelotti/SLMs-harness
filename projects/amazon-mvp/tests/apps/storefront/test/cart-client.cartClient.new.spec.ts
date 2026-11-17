import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cartClient, CartRequestError } from '../src/features/cart/cart-client';

const realFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const CART = { id: 'cart-1', userId: 'user-1', lines: [], itemCount: 0, subtotalMinor: 0, currency: 'BRL' };

beforeEach(() => {
  fetchMock = vi.fn(async () => json(200, CART));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

function lastCall(): { url: string; init: RequestInit } {
  const [url, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
  return { url, init };
}

async function failure(promise: Promise<unknown>): Promise<CartRequestError> {
  try {
    await promise;
  } catch (error) {
    return error as CartRequestError;
  }
  throw new Error('expected the request to fail');
}

describe('cartClient requests', () => {
  it('reads the current cart with a same-origin, uncached GET and returns the body', async () => {
    expect(await cartClient.get()).toEqual(CART);
    const { url, init } = lastCall();
    expect(url).toBe('/api/v1/cart');
    expect(init.method).toBe('GET');
    expect(init.credentials).toBe('same-origin');
    expect(init.cache).toBe('no-store');
    expect(init.headers).toBeUndefined();
    expect(init.body).toBeUndefined();
  });

  it('adds an item with a JSON POST', async () => {
    await cartClient.add({ productId: 'p1', quantity: 2 });
    const { url, init } = lastCall();
    expect(url).toBe('/api/v1/cart/items');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'content-type': 'application/json' });
    expect(init.body).toBe(JSON.stringify({ productId: 'p1', quantity: 2 }));
    expect(init.credentials).toBe('same-origin');
    expect(init.cache).toBe('no-store');
  });

  it('updates a quantity with a JSON PATCH on the encoded product id', async () => {
    await cartClient.update('a/b', 3);
    const { url, init } = lastCall();
    expect(url).toBe('/api/v1/cart/items/a%2Fb');
    expect(init.method).toBe('PATCH');
    expect(init.headers).toEqual({ 'content-type': 'application/json' });
    expect(init.body).toBe(JSON.stringify({ quantity: 3 }));
  });

  it('removes one item or clears the cart with bodiless DELETEs', async () => {
    await cartClient.remove('a b');
    expect(lastCall().url).toBe('/api/v1/cart/items/a%20b');
    expect(lastCall().init.method).toBe('DELETE');
    expect(lastCall().init.headers).toBeUndefined();
    expect(lastCall().init.body).toBeUndefined();

    await cartClient.clear();
    expect(lastCall().url).toBe('/api/v1/cart/items');
    expect(lastCall().init.method).toBe('DELETE');
    expect(lastCall().init.body).toBeUndefined();
  });
});

describe('cartClient errors', () => {
  it('uses the API error message and keeps the status', async () => {
    fetchMock.mockImplementation(async () =>
      json(409, { error: { code: 'CONFLICT', message: 'Sem estoque', requestId: 'req-1' } }),
    );
    const error = await failure(cartClient.add({ productId: 'p1', quantity: 1 }));
    expect(error).toBeInstanceOf(CartRequestError);
    expect(error.message).toBe('Sem estoque');
    expect(error.status).toBe(409);
  });

  it('falls back to a generic message for bodies that are not API errors', async () => {
    fetchMock.mockImplementation(async () => new Response('Bad gateway', { status: 502 }));
    const error = await failure(cartClient.get());
    expect(error).toBeInstanceOf(CartRequestError);
    expect(error.message).toBe('Não foi possível atualizar seu carrinho.');
    expect(error.status).toBe(502);

    fetchMock.mockImplementation(async () => json(503, { error: {} }));
    const other = await failure(cartClient.clear());
    expect(other.message).toBe('Não foi possível atualizar seu carrinho.');
    expect(other.status).toBe(503);
  });

  it('sends 401 responses through as a CartRequestError', async () => {
    fetchMock.mockImplementation(async () =>
      json(401, { error: { code: 'AUTH_SESSION_REQUIRED', message: 'Entre novamente.', requestId: 'r' } }),
    );
    const error = await failure(cartClient.get());
    expect(error.status).toBe(401);
    expect(error.message).toBe('Entre novamente.');
  });
});
