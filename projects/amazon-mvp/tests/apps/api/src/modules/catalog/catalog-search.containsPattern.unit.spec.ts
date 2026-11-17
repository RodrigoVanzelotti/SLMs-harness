import {
  ACCENTED,
  PLAIN,
  containsPattern,
  escapeLike,
  normalizeText,
  searchTokens,
} from './catalog-search';

describe('catalog search tokens', () => {

  it('escapes LIKE wildcards so they match literally', () => {
    expect(escapeLike('50%_off\\')).toBe('50\\%\\_off\\\\');
    expect(containsPattern('100%')).toBe('%100\\%%');
  });
});
