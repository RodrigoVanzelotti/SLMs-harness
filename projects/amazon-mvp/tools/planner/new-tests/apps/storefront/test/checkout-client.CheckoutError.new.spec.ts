import { describe, expect, it } from 'vitest';
import { CheckoutError } from '../src/features/checkout/checkout-client';

describe('CheckoutError', () => {
  it('is an Error carrying the message and the HTTP status', () => {
    const error = new CheckoutError('Entre novamente', 401);
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(CheckoutError);
    expect(error.message).toBe('Entre novamente');
    expect(error.status).toBe(401);
  });
});
