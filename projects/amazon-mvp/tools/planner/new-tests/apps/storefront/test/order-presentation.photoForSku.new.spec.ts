import { describe, expect, it } from 'vitest';
import { photoForSku } from '../src/features/orders/order-presentation';

describe('photoForSku', () => {
  it('returns the demo product photo with the same SKU', () => {
    expect(photoForSku('DEMO-p3')).toEqual({ src: '/images/products/kindle.jpg', alt: 'Kindle preto' });
  });

  it('also finds variant products', () => {
    expect(photoForSku('DEMO-p21')?.src).toBe('/images/products/8bitdo-ultimate-2c/pessego-1.jpg');
  });

  it('returns undefined for an unknown SKU', () => {
    expect(photoForSku('NO-MEDIA')).toBeUndefined();
  });
});
