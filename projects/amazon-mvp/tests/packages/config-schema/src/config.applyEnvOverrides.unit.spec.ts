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

describe('applyEnvOverrides', () => {
  it('overrides nested paths and coerces scalars', () => {
    const result = applyEnvOverrides(
      { app: { port: 3000, logLevel: 'info' }, openapi: { enabled: true } },
      { 'app.port': 'PORT', 'openapi.enabled': 'OPENAPI_ENABLED' },
      { PORT: '8080', OPENAPI_ENABLED: 'false' },
    );
    expect(result).toEqual({ app: { port: 8080, logLevel: 'info' }, openapi: { enabled: false } });
  });

  it('ignores unset and empty env vars', () => {
    const result = applyEnvOverrides({ app: { port: 3000 } }, { 'app.port': 'PORT' }, { PORT: '' });
    expect(result).toEqual({ app: { port: 3000 } });
  });
});
