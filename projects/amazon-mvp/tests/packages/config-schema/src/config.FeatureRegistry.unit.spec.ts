import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApiConfigSchema } from './app-config';
import { FeatureRegistry } from './features';
import { ConfigValidationError, applyEnvOverrides, loadConfig, mergeDeep } from './loader';

const baseFeatures = {
  features: {
    authentication: { enabled: true },
    catalog: { enabled: false },
    checkout: { enabled: false },
  },
  routes: {
    products: { feature: 'catalog', disabledBehavior: 'coming-soon' },
    checkout: { feature: 'checkout', disabledBehavior: 'not-found' },
    login: { feature: 'authentication', disabledBehavior: 'coming-soon' },
  },
};

describe('FeatureRegistry', () => {
  it('reports enabled features', () => {
    const registry = FeatureRegistry.fromConfig(baseFeatures);
    expect(registry.isEnabled('authentication')).toBe(true);
    expect(registry.isEnabled('catalog')).toBe(false);
    expect(registry.enabledFeatures()).toEqual(['authentication']);
  });

  it('treats unknown features as disabled', () => {
    const registry = FeatureRegistry.fromConfig(baseFeatures);
    expect(registry.isEnabled('warehouse')).toBe(false);
  });

  it('resolves route state from the backing feature', () => {
    const registry = FeatureRegistry.fromConfig(baseFeatures);
    expect(registry.routeState('login')).toBe('enabled');
    expect(registry.routeState('products')).toBe('coming-soon');
    expect(registry.routeState('checkout')).toBe('not-found');
  });

  it('leaves unregistered routes ungated', () => {
    const registry = FeatureRegistry.fromConfig(baseFeatures);
    expect(registry.routeState('health')).toBe('enabled');
  });

  it('defaults disabledBehavior to coming-soon', () => {
    const registry = FeatureRegistry.fromConfig({
      features: { cart: { enabled: false } },
      routes: { cart: { feature: 'cart' } },
    });
    expect(registry.routeState('cart')).toBe('coming-soon');
  });

  it('rejects a route bound to an unknown feature', () => {
    expect(() =>
      FeatureRegistry.fromConfig({
        features: { cart: { enabled: true } },
        routes: { cart: { feature: 'crat' } },
      }),
    ).toThrow(/unknown feature/);
  });

  it('rejects a non-boolean enabled value', () => {
    expect(() =>
      FeatureRegistry.fromConfig({ features: { cart: { enabled: 'yes' } } }),
    ).toThrow();
  });
});
