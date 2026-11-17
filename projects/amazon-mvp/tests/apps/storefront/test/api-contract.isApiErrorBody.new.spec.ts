import { describe, expect, it } from 'vitest';
import { isApiErrorBody } from '@amazon-mvp/api-contract';

describe('isApiErrorBody', () => {
  it('accepts the API error envelope', () => {
    expect(
      isApiErrorBody({
        error: { code: 'RESOURCE_NOT_FOUND', message: 'Order not found', requestId: 'req-1' },
      }),
    ).toBe(true);
    expect(
      isApiErrorBody({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Request validation failed',
          requestId: 'req-2',
          details: [{ field: 'email', message: 'email must be an email' }],
        },
      }),
    ).toBe(true);
  });

  it('only requires a string code inside an error object', () => {
    expect(isApiErrorBody({ error: { code: 'ANY' } })).toBe(true);
    expect(isApiErrorBody({ error: { code: 404 } })).toBe(false);
    expect(isApiErrorBody({ error: { message: 'no code' } })).toBe(false);
  });

  it('rejects anything that is not that envelope', () => {
    for (const value of [null, undefined, 'error', 42, [], {}, { error: null }, { error: 'boom' }]) {
      expect(isApiErrorBody(value)).toBe(false);
    }
    expect(isApiErrorBody({ code: 'AUTH_SESSION_REQUIRED', message: 'Sign in to continue' })).toBe(
      false,
    );
  });
});
