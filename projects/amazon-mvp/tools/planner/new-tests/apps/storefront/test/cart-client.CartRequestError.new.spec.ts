import { describe, expect, it } from 'vitest';
import { CartRequestError } from '../src/features/cart/cart-client';

describe('CartRequestError', () => {
  it('is an Error carrying the message and the HTTP status', () => {
    const error = new CartRequestError('Sem estoque', 409);
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(CartRequestError);
    expect(error.message).toBe('Sem estoque');
    expect(error.status).toBe(409);
  });
});
