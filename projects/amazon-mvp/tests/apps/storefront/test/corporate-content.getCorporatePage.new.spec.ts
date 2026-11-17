import { describe, expect, it } from 'vitest';
import { CORPORATE_PAGES, getCorporatePage } from '../src/features/corporate/corporate-content';
import type { CorporatePageKey } from '../src/features/corporate/corporate-routes';

describe('getCorporatePage', () => {
  it('returns the page object of CORPORATE_PAGES with that key', () => {
    for (const page of CORPORATE_PAGES) {
      expect(getCorporatePage(page.key)).toBe(page);
    }
  });

  it('finds pages of both footer groups', () => {
    const press = getCorporatePage('press');
    expect(press.key).toBe('press');
    expect(press.href).toBe('/press');
    expect(press.group).toBe('knowUs');

    const advertise = getCorporatePage('advertise');
    expect(advertise.href).toBe('/advertise');
    expect(advertise.group).toBe('earn');

    expect(getCorporatePage('corporateInformation').href).toBe('/corporate-information');
    expect(getCorporatePage('amazonScience').href).toBe('/amazon-science');
  });

  it('throws for a key that has no page', () => {
    expect(() => getCorporatePage('sell' as CorporatePageKey)).toThrow(
      'Unknown corporate page: sell',
    );
  });
});
