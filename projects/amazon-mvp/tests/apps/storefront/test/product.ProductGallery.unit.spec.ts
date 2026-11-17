// @vitest-environment jsdom
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProductGallery } from '../src/features/product/product-gallery';
import { ProductPurchase } from '../src/features/product/product-purchase';
import { useCart } from '../src/features/cart/cart-provider';
import { CatalogItem } from '@amazon-mvp/api-contract';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
vi.mock('../src/features/cart/cart-provider', () => ({ useCart: vi.fn() }));
vi.mock('next/image', () => ({
  default: ({ priority: _p, sizes: _s, ...props }: Record<string, unknown>) =>
    createElement('img', props),
}));
const product: CatalogItem = {
  id: 'real-product-id',
  slug: 'real-product',
  sku: 'TEST',
  name: 'Product',
  description: null,
  priceMinor: 1099,
  currency: 'BRL',
  active: true,
  availableQuantity: 10,
  inStock: true,
};
const state = () => ({
  cart: null,
  status: 'ready' as const,
  pending: false,
  error: null,
  notice: '',
  refresh: vi.fn(),
  add: vi.fn().mockResolvedValue(true),
  update: vi.fn().mockResolvedValue(true),
  remove: vi.fn(),
  clear: vi.fn(),
});
const withLine = (quantity: number) => ({
  ...state(),
  cart: {
    id: 'cart',
    userId: 'user',
    lines: [
      {
        productId: product.id,
        product,
        quantity,
        unitPriceMinor: 1099,
        lineTotalMinor: 1099 * quantity,
      },
    ],
    itemCount: quantity,
    subtotalMinor: 1099 * quantity,
    currency: 'BRL',
  },
});
beforeEach(() => {
  push.mockReset();
  vi.mocked(useCart).mockReturnValue(state());
});
afterEach(cleanup);

const images = (count: number) =>
  Array.from({ length: count }, (_, i) => ({ src: `/p-${i + 1}.jpg`, alt: `Foto ${i + 1}` }));

describe('product gallery', () => {
  it('switches the main image on thumbnail click and hover', () => {
    render(createElement(ProductGallery, { name: 'Product', images: images(3) }));
    const main = () => screen.getByRole('button', { name: /Ampliar imagem/ }).querySelector('img');
    expect(main()?.getAttribute('src')).toBe('/p-1.jpg');
    fireEvent.click(screen.getByRole('button', { name: 'Ver imagem 2 de Product' }));
    expect(main()?.getAttribute('src')).toBe('/p-2.jpg');
    const third = screen.getByRole('button', { name: 'Ver imagem 3 de Product' });
    fireEvent.mouseEnter(third);
    expect(third.getAttribute('aria-pressed')).toBe('true');
    expect(main()?.getAttribute('src')).toBe('/p-3.jpg');
  });

  it('folds extra thumbnails into "N+" and shows every image in the viewer', () => {
    render(createElement(ProductGallery, { name: 'Product', images: images(9) }));
    const group = screen.getByRole('group', { name: 'Escolher imagem do produto' });
    expect(within(group).getAllByRole('button', { name: /Ver imagem/ })).toHaveLength(6);
    fireEvent.click(within(group).getByRole('button', { name: 'Ver todas as 9 imagens' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getAllByRole('button', { name: /Imagem \d de 9/ })).toHaveLength(9);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Imagem 8 de 9' }));
    expect(within(dialog).getByAltText('Foto 8')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    expect(within(screen.getByRole('dialog')).getByAltText('Foto 9')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens the full image from the main picture', () => {
    render(createElement(ProductGallery, { name: 'Product', images: images(2) }));
    fireEvent.click(screen.getByRole('button', { name: 'Ampliar imagem: Foto 1' }));
    expect(screen.getByRole('dialog', { name: 'Imagens de Product' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Fechar' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows a single image without inventing thumbnails', () => {
    render(createElement(ProductGallery, { name: 'Product', images: images(1) }));
    expect(screen.queryByRole('group')).toBeNull();
    expect(screen.getByAltText('Foto 1')).toBeTruthy();
  });

  it('uses the shared placeholder without photos or when a photo fails', () => {
    const view = render(createElement(ProductGallery, { name: 'Product', images: [] }));
    expect(screen.getByText('Imagem indisponível')).toBeTruthy();
    expect(screen.queryByText('Clique para ver a imagem completa')).toBeNull();
    view.unmount();
    render(createElement(ProductGallery, { name: 'Product', images: images(1) }));
    fireEvent.error(screen.getByAltText('Foto 1'));
    expect(screen.getByText('Imagem indisponível')).toBeTruthy();
  });
});
