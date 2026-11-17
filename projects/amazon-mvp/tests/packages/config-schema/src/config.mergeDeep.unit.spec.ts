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

describe('mergeDeep', () => {
  it('merges nested objects with later sources winning', () => {
    expect(mergeDeep({ a: { b: 1, c: 2 } }, { a: { c: 3 } })).toEqual({ a: { b: 1, c: 3 } });
  });
});
