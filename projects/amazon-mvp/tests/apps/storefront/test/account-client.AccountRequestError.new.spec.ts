import { describe, expect, it } from 'vitest';
import { AccountRequestError } from '../src/features/account/account-client';

describe('AccountRequestError', () => {
  it('is an Error carrying the HTTP status and the API error code', () => {
    const error = new AccountRequestError('Sua sessão expirou.', 401, 'AUTH_SESSION_REQUIRED');
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(AccountRequestError);
    expect(error.message).toBe('Sua sessão expirou.');
    expect(error.status).toBe(401);
    expect(error.code).toBe('AUTH_SESSION_REQUIRED');
  });
});
