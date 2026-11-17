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

describe('loadConfig', () => {
  const writeConfigDir = (files: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
    return dir;
  };

  const defaultYaml = `
app:
  name: api
  environment: local
  port: 3000
  logLevel: info
database:
  url: postgresql://localhost:5432/dev
session:
  cookieName: sid
  ttlHours: 24
  secureCookie: false
  sameSite: lax
openapi:
  enabled: true
  path: /api/docs
`;

  it('applies defaults -> environment yaml -> env vars in order', () => {
    const dir = writeConfigDir({
      'default.yaml': defaultYaml,
      'production.yaml': 'app:\n  environment: production\nsession:\n  secureCookie: true\n',
    });

    const config = loadConfig({
      configDir: dir,
      environment: 'production',
      schema: ApiConfigSchema,
      envMap: { 'app.port': 'PORT', 'database.url': 'DATABASE_URL' },
      env: { PORT: '8080', DATABASE_URL: 'postgresql://db:5432/prod' },
    });

    expect(config.app.environment).toBe('production'); // env yaml beat defaults
    expect(config.session.secureCookie).toBe(true);
    expect(config.app.port).toBe(8080); // env var beat yaml
    expect(config.database.url).toBe('postgresql://db:5432/prod');
    expect(config.app.logLevel).toBe('info'); // untouched default
  });

  it('fails fast with a readable error on invalid configuration', () => {
    const dir = writeConfigDir({
      'default.yaml': defaultYaml,
      'local.yaml': 'app:\n  port: not-a-number\n',
    });

    expect(() =>
      loadConfig({ configDir: dir, environment: 'local', schema: ApiConfigSchema, env: {} }),
    ).toThrow(ConfigValidationError);
  });

  it('fails when a required secret is missing entirely', () => {
    const dir = writeConfigDir({
      'default.yaml': defaultYaml.replace('  url: postgresql://localhost:5432/dev', '  url: ""'),
    });

    expect(() =>
      loadConfig({ configDir: dir, environment: 'local', schema: ApiConfigSchema, env: {} }),
    ).toThrow(/database.url is required/);
  });

  it('defaults the Pix discount to 5% and accepts an env override', () => {
    const dir = writeConfigDir({ 'default.yaml': defaultYaml });
    const load = (env: NodeJS.ProcessEnv) =>
      loadConfig({
        configDir: dir,
        environment: 'local',
        schema: ApiConfigSchema,
        envMap: { 'checkout.pixDiscountPercent': 'PIX_DISCOUNT_PERCENT' },
        env,
      });
    expect(load({}).checkout.pixDiscountPercent).toBe(5);
    expect(load({ PIX_DISCOUNT_PERCENT: '0' }).checkout.pixDiscountPercent).toBe(0);
    expect(load({ PIX_DISCOUNT_PERCENT: '100' }).checkout.pixDiscountPercent).toBe(100);
  });

  it.each(['-1', '101', '2.5', 'five'])('rejects a Pix discount of %s', (value) => {
    const dir = writeConfigDir({ 'default.yaml': defaultYaml });
    expect(() =>
      loadConfig({
        configDir: dir,
        environment: 'local',
        schema: ApiConfigSchema,
        envMap: { 'checkout.pixDiscountPercent': 'PIX_DISCOUNT_PERCENT' },
        env: { PIX_DISCOUNT_PERCENT: value },
      }),
    ).toThrow(/checkout.pixDiscountPercent/);
  });
});
