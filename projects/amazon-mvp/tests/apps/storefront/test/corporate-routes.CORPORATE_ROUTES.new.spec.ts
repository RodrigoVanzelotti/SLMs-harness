import { describe, expect, it } from 'vitest';
import { CORPORATE_GROUPS, CORPORATE_ROUTES } from '../src/features/corporate/corporate-routes';

describe('CORPORATE_ROUTES', () => {
  it('lists the href of every group link that has a pageKey, in group then link order', () => {
    expect(CORPORATE_ROUTES).toEqual([
      '/about',
      '/corporate-information',
      '/careers',
      '/press',
      '/community',
      '/accessibility',
      '/amazon-science',
      '/brand-protection',
      '/supply',
      '/publish',
      '/associates',
      '/advertise',
    ]);
  });

  it('leaves out links without a pageKey, such as /sell', () => {
    expect(CORPORATE_ROUTES).not.toContain('/sell');
    const withoutKey = CORPORATE_GROUPS.flatMap((group) => group.links).filter((link) => !link.pageKey);
    expect(withoutKey.map((link) => link.href)).toEqual(['/sell']);
    expect(CORPORATE_ROUTES).toHaveLength(
      CORPORATE_GROUPS.flatMap((group) => group.links).length - withoutKey.length,
    );
  });
});
