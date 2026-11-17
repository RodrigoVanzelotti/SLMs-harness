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

  it('lists the five problems in Amazon order after "< Selecione >"', () => {
    render(createElement(AccountIssues));
    expect(Array.from(select().options, (option) => option.text)).toEqual([
      '< Selecione >',
      'Esqueci a minha senha',
      'Minha senha não está funcionando',
      'Não tenho conta na Amazon, mas preciso de ajuda',
      'Não consigo criar uma conta',
      'Não consigo passar pelo processo de verificação em duas etapas',
    ]);
    expect(screen.queryByRole('heading', { name: 'Você sabia?' })).toBeNull();
  });

  it.each([
    ['forgot-password', /verifique sua caixa de Spam/],
    ['password-not-working', /ligue para: 0800 037 0715/],
    ['no-account', /\+55 11 3958 5225/],
    ['cannot-create-account', /Lamentamos que tenha tido problemas/],
    ['two-step-verification', /pode levar de 1 a 2 dias/],
  ])('shows the "Você sabia?" answer for %s', (id, snippet) => {
    render(createElement(AccountIssues));
    fireEvent.change(select(), { target: { value: id } });
    expect(screen.getByRole('heading', { name: 'Você sabia?' })).toBeTruthy();
    expect(screen.getByText(snippet)).toBeTruthy();
  });

  it('swaps the answer and hides it again on "< Selecione >"', () => {
    render(createElement(AccountIssues));
    fireEvent.change(select(), { target: { value: 'forgot-password' } });
    fireEvent.change(select(), { target: { value: 'cannot-create-account' } });
    expect(screen.queryByText(/caixa de Spam/)).toBeNull();
    expect(screen.getByRole('link', { name: 'Criar conta' }).getAttribute('href')).toBe('/register');

    fireEvent.change(select(), { target: { value: '' } });
    expect(screen.queryByRole('heading', { name: 'Você sabia?' })).toBeNull();
  });

  it('numbers the two-step recovery instructions', () => {
    render(createElement(AccountIssues));
    fireEvent.change(select(), { target: { value: 'two-step-verification' } });
    const steps = screen.getAllByRole('listitem').map((item) => item.textContent);
    expect(steps).toEqual([
      'Vá para Recuperação da conta com verificação em duas etapas.',
      'Siga as instruções na tela para fazer o upload do seu documento de identidade.',
    ]);
  });
});
