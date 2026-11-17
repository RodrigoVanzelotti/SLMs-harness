// @vitest-environment jsdom
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { FeatureRegistry, readYamlFile } from '@amazon-mvp/config-schema';
import { afterEach, describe, expect, it } from 'vitest';
import { AccountIssues } from '../src/features/account-issues/account-issues';
import { ACCOUNT_ISSUES } from '../src/features/account-issues/account-issues-content';

afterEach(cleanup);

const SRC = join(process.cwd(), 'src');
const REPO_FEATURES = join(process.cwd(), '..', '..', 'config', 'features.yaml');

const select = () => screen.getByLabelText('Selecione um problema') as HTMLSelectElement;

describe('account issues (/account-issues)', () => {
  it('is enabled, served by its own route and linked from "Precisa de ajuda?" on /login', () => {
    const registry = FeatureRegistry.fromConfig(readYamlFile(REPO_FEATURES));
    expect(registry.isEnabled('accountIssues')).toBe(true);
    expect(existsSync(join(SRC, 'app', 'account-issues', 'page.tsx'))).toBe(true);

    const login = readFileSync(join(SRC, 'features', 'auth', 'login-identifier-form.tsx'), 'utf8');
    expect(login).toMatch(/href="\/account-issues">\s*Precisa de ajuda\?/);
  });
});
