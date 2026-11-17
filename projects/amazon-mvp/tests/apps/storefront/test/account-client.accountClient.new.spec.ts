import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accountClient, AccountRequestError } from '../src/features/account/account-client';

const realFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const apiError = (status: number, code: string, message = 'API message', details?: unknown) =>
  json(status, { error: { code, message, requestId: 'req-1', ...(details ? { details } : {}) } });

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

function lastCall(): { url: string; init: RequestInit } {
  const [url, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
  return { url, init };
}

async function failure(promise: Promise<unknown>): Promise<AccountRequestError> {
  try {
    await promise;
  } catch (error) {
    return error as AccountRequestError;
  }
  throw new Error('expected the request to fail');
}

describe('accountClient requests', () => {
  it('reads addresses and lists with same-origin, uncached GETs and no body', async () => {
    fetchMock.mockImplementation(async () => json(200, []));
    await accountClient.addresses();
    expect(lastCall().url).toBe('/api/v1/addresses');
    expect(lastCall().init.method).toBe('GET');
    expect(lastCall().init.credentials).toBe('same-origin');
    expect(lastCall().init.cache).toBe('no-store');
    expect(lastCall().init.body).toBeUndefined();

    await accountClient.lists();
    expect(lastCall().url).toBe('/api/v1/lists');
    expect(lastCall().init.method).toBe('GET');

    await accountClient.list('l 1');
    expect(lastCall().url).toBe('/api/v1/lists/l%201');
    expect(lastCall().init.method).toBe('GET');
  });

  it('sends JSON bodies with a content-type header for writes', async () => {
    fetchMock.mockImplementation(async () => json(200, {}));
    const data = {
      recipient: 'Pessoa Teste',
      postalCode: '01001000',
      street: 'Rua Exemplo',
      number: '10',
      neighborhood: 'Centro',
      city: 'São Paulo',
      state: 'SP',
    };
    await accountClient.updateAddress('a/b', data);
    expect(lastCall().url).toBe('/api/v1/addresses/a%2Fb');
    expect(lastCall().init.method).toBe('PUT');
    expect(lastCall().init.headers).toEqual({ 'content-type': 'application/json' });
    expect(lastCall().init.body).toBe(JSON.stringify(data));
    expect(lastCall().init.credentials).toBe('same-origin');
    expect(lastCall().init.cache).toBe('no-store');

    await accountClient.updateName('Ada');
    expect(lastCall().url).toBe('/api/v1/account/profile');
    expect(lastCall().init.method).toBe('PATCH');
    expect(JSON.parse(String(lastCall().init.body))).toEqual({ displayName: 'Ada' });

    await accountClient.changeEmail('ada@example.test', 'senha atual 123');
    expect(lastCall().url).toBe('/api/v1/account/email');
    expect(lastCall().init.method).toBe('POST');
    expect(JSON.parse(String(lastCall().init.body))).toEqual({
      email: 'ada@example.test',
      currentPassword: 'senha atual 123',
    });

    await accountClient.changePassword('senha atual 123', 'senha nova 4567');
    expect(lastCall().url).toBe('/api/v1/account/password');
    expect(lastCall().init.method).toBe('POST');
    expect(JSON.parse(String(lastCall().init.body))).toEqual({
      currentPassword: 'senha atual 123',
      newPassword: 'senha nova 4567',
    });
  });

  it('builds the address and list action routes', async () => {
    fetchMock.mockImplementation(async () => json(200, []));
    await accountClient.deleteAddress('x');
    expect(lastCall().url).toBe('/api/v1/addresses/x');
    expect(lastCall().init.method).toBe('DELETE');
    expect(lastCall().init.body).toBeUndefined();

    await accountClient.setDefaultAddress('x y');
    expect(lastCall().url).toBe('/api/v1/addresses/x%20y/default');
    expect(lastCall().init.method).toBe('POST');
    expect(lastCall().init.body).toBeUndefined();

    await accountClient.createList('Presentes');
    expect(lastCall().url).toBe('/api/v1/lists');
    expect(lastCall().init.method).toBe('POST');
    expect(JSON.parse(String(lastCall().init.body))).toEqual({ name: 'Presentes' });

    await accountClient.renameList('l1', 'Natal');
    expect(lastCall().url).toBe('/api/v1/lists/l1');
    expect(lastCall().init.method).toBe('PATCH');
    expect(JSON.parse(String(lastCall().init.body))).toEqual({ name: 'Natal' });

    await accountClient.addToList('l1', 'p1');
    expect(lastCall().url).toBe('/api/v1/lists/l1/items');
    expect(lastCall().init.method).toBe('POST');
    expect(JSON.parse(String(lastCall().init.body))).toEqual({ productId: 'p1' });

    await accountClient.removeFromList('l1', 'p/1');
    expect(lastCall().url).toBe('/api/v1/lists/l1/items/p%2F1');
    expect(lastCall().init.method).toBe('DELETE');
    expect(lastCall().init.body).toBeUndefined();
  });

  it('resolves with the parsed payload, or undefined for 204', async () => {
    const lists = [{ id: 'l1', name: 'Lista de desejos', isDefault: true, itemCount: 0, createdAt: '' }];
    fetchMock.mockResolvedValue(json(200, lists));
    await expect(accountClient.lists()).resolves.toEqual(lists);

    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(accountClient.deleteList('l1')).resolves.toBeUndefined();
    expect(lastCall().url).toBe('/api/v1/lists/l1');
    expect(lastCall().init.method).toBe('DELETE');
  });
});

describe('accountClient errors', () => {
  it('reports a network failure as status 0, code NETWORK', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const error = await failure(accountClient.addresses());
    expect(error).toBeInstanceOf(AccountRequestError);
    expect(error.message).toBe('Não foi possível conectar. Tente novamente.');
    expect(error.status).toBe(0);
    expect(error.code).toBe('NETWORK');
  });

  it('maps the codes and statuses the account pages can hit to pt-BR messages', async () => {
    fetchMock.mockResolvedValue(apiError(403, 'AUTH_INVALID_CREDENTIALS'));
    let error = await failure(accountClient.changePassword('a', 'b'));
    expect([error.message, error.status, error.code]).toEqual([
      'Sua senha atual está incorreta.',
      403,
      'AUTH_INVALID_CREDENTIALS',
    ]);

    fetchMock.mockResolvedValue(apiError(409, 'AUTH_EMAIL_ALREADY_REGISTERED'));
    error = await failure(accountClient.changeEmail('a@b.test', 'x'));
    expect([error.message, error.status, error.code]).toEqual([
      'Já existe uma conta com este e-mail.',
      409,
      'AUTH_EMAIL_ALREADY_REGISTERED',
    ]);

    fetchMock.mockResolvedValue(apiError(401, 'AUTH_SESSION_REQUIRED'));
    error = await failure(accountClient.lists());
    expect([error.message, error.status, error.code]).toEqual([
      'Sua sessão expirou. Entre novamente para continuar.',
      401,
      'AUTH_SESSION_REQUIRED',
    ]);

    fetchMock.mockResolvedValue(apiError(404, 'RESOURCE_NOT_FOUND'));
    error = await failure(accountClient.list('gone'));
    expect([error.message, error.status, error.code]).toEqual([
      'Este item não existe mais. Atualize a página.',
      404,
      'RESOURCE_NOT_FOUND',
    ]);
  });

  it('checks the error code before the status', async () => {
    fetchMock.mockResolvedValue(apiError(401, 'AUTH_INVALID_CREDENTIALS'));
    const error = await failure(accountClient.changePassword('a', 'b'));
    expect(error.message).toBe('Sua senha atual está incorreta.');
    expect(error.status).toBe(401);
  });

  it('asks to review the fields when the API sends validation details', async () => {
    fetchMock.mockResolvedValue(
      apiError(400, 'VALIDATION_FAILED', 'Invalid', [{ field: 'name', message: 'too long' }]),
    );
    const error = await failure(accountClient.createList('x'));
    expect([error.message, error.status, error.code]).toEqual([
      'Confira os campos e tente novamente.',
      400,
      'VALIDATION_FAILED',
    ]);
  });

  it('passes through the API message only for the list limit and default-list codes', async () => {
    fetchMock.mockResolvedValue(apiError(409, 'LIST_LIMIT_EXCEEDED', 'Limite de listas atingido.'));
    let error = await failure(accountClient.createList('x'));
    expect([error.message, error.code]).toEqual(['Limite de listas atingido.', 'LIST_LIMIT_EXCEEDED']);

    fetchMock.mockResolvedValue(
      apiError(409, 'LIST_DEFAULT_PROTECTED', 'A lista padrão não pode ser excluída.'),
    );
    error = await failure(accountClient.deleteList('l1'));
    expect([error.message, error.code]).toEqual([
      'A lista padrão não pode ser excluída.',
      'LIST_DEFAULT_PROTECTED',
    ]);

    fetchMock.mockResolvedValue(apiError(409, 'CARD_LIMIT_EXCEEDED', 'Not shown'));
    error = await failure(accountClient.addresses());
    expect([error.message, error.code]).toEqual([
      'Não foi possível concluir a solicitação.',
      'CARD_LIMIT_EXCEEDED',
    ]);
  });

  it('falls back to a generic message and code UNKNOWN when the body is not an API error', async () => {
    fetchMock.mockResolvedValue(new Response('<html>Bad gateway</html>', { status: 502 }));
    const error = await failure(accountClient.addresses());
    expect([error.message, error.status, error.code]).toEqual([
      'Não foi possível concluir a solicitação.',
      502,
      'UNKNOWN',
    ]);

    fetchMock.mockResolvedValue(json(404, { message: 'not an api error body' }));
    const missing = await failure(accountClient.list('x'));
    expect([missing.message, missing.status, missing.code]).toEqual([
      'Este item não existe mais. Atualize a página.',
      404,
      'UNKNOWN',
    ]);
  });
});
