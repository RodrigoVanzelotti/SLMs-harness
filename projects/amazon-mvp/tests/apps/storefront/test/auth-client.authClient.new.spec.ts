import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authClient, AuthRequestError } from '../src/features/auth/auth-client';

const realFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

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

async function failure(promise: Promise<unknown>): Promise<AuthRequestError> {
  try {
    await promise;
  } catch (error) {
    return error as AuthRequestError;
  }
  throw new Error('expected the request to fail');
}

describe('authClient requests', () => {
  it('POSTs JSON to the same-origin auth routes', async () => {
    fetchMock.mockImplementation(async () => json(200, { exists: true }));

    await expect(authClient.identify({ email: 'ada@example.test' })).resolves.toEqual({
      exists: true,
    });
    expect(lastCall().url).toBe('/api/v1/auth/identify');
    expect(lastCall().init.method).toBe('POST');
    expect(lastCall().init.headers).toEqual({ 'content-type': 'application/json' });
    expect(lastCall().init.credentials).toBe('same-origin');
    expect(lastCall().init.body).toBe(JSON.stringify({ email: 'ada@example.test' }));

    const register = { email: 'ada@example.test', password: 'senha forte 123', displayName: 'Ada' };
    await authClient.register(register);
    expect(lastCall().url).toBe('/api/v1/auth/register');
    expect(lastCall().init.method).toBe('POST');
    expect(lastCall().init.body).toBe(JSON.stringify(register));

    await authClient.login({ email: 'ada@example.test', password: 'senha forte 123' });
    expect(lastCall().url).toBe('/api/v1/auth/login');
    expect(lastCall().init.method).toBe('POST');
    expect(JSON.parse(String(lastCall().init.body))).toEqual({
      email: 'ada@example.test',
      password: 'senha forte 123',
    });
  });

  it('logs out with a bodiless POST', async () => {
    fetchMock.mockResolvedValue(json(200, { success: true }));
    await expect(authClient.logout()).resolves.toEqual({ success: true });
    expect(lastCall().url).toBe('/api/v1/auth/logout');
    expect(lastCall().init.method).toBe('POST');
    expect(lastCall().init.body).toBeUndefined();
  });
});

describe('authClient errors', () => {
  it('reports an unreachable server as NETWORK_ERROR', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const error = await failure(authClient.login({ email: 'a@b.test', password: 'x' }));
    expect(error).toBeInstanceOf(AuthRequestError);
    expect(error.message).toBe('Could not reach the server. Check your connection and try again.');
    expect(error.code).toBe('NETWORK_ERROR');
    expect(error.fieldErrors).toEqual({});
  });

  it('keeps the API message and code, and maps validation details by field', async () => {
    fetchMock.mockResolvedValue(
      json(400, {
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Request validation failed',
          requestId: 'req-1',
          details: [
            { field: 'email', message: 'email must be an email' },
            { field: 'password', message: 'password is too short' },
          ],
        },
      }),
    );
    const error = await failure(
      authClient.register({ email: 'x', password: 'y', displayName: 'Ada' }),
    );
    expect(error.message).toBe('Request validation failed');
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.fieldErrors).toEqual({
      email: 'email must be an email',
      password: 'password is too short',
    });
  });

  it('has no field errors when the API error has no details', async () => {
    fetchMock.mockResolvedValue(
      json(401, {
        error: { code: 'AUTH_INVALID_CREDENTIALS', message: 'Invalid email or password', requestId: 'r' },
      }),
    );
    const error = await failure(authClient.login({ email: 'a@b.test', password: 'x' }));
    expect(error.message).toBe('Invalid email or password');
    expect(error.code).toBe('AUTH_INVALID_CREDENTIALS');
    expect(error.fieldErrors).toEqual({});
  });

  it('uses a generic UNKNOWN error when the failure body is not an API error', async () => {
    fetchMock.mockResolvedValue(new Response('Bad gateway', { status: 502 }));
    const error = await failure(authClient.identify({ email: 'a@b.test' }));
    expect(error.message).toBe('Something went wrong. Try again.');
    expect(error.code).toBe('UNKNOWN');
    expect(error.fieldErrors).toEqual({});
  });
});
