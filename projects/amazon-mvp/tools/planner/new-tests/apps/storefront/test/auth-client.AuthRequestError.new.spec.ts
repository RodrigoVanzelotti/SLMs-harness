import { describe, expect, it } from 'vitest';
import { AuthRequestError } from '../src/features/auth/auth-client';

describe('AuthRequestError', () => {
  it('is a named Error with a code and per-field messages', () => {
    const error = new AuthRequestError('Invalid input', 'VALIDATION_FAILED', {
      email: 'Informe um e-mail válido.',
    });
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(AuthRequestError);
    expect(error.name).toBe('AuthRequestError');
    expect(error.message).toBe('Invalid input');
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.fieldErrors).toEqual({ email: 'Informe um e-mail válido.' });
  });

  it('defaults fieldErrors to an empty object', () => {
    expect(new AuthRequestError('x', 'UNKNOWN').fieldErrors).toEqual({});
  });
});
