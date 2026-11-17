import {
  ACCENTED,
  PLAIN,
  containsPattern,
  escapeLike,
  normalizeText,
  searchTokens,
} from './catalog-search';

describe('catalog search tokens', () => {

  it('splits on punctuation, drops duplicates and one-letter words next to real ones', () => {
    expect(searchTokens('  Fone   e fone-Bluetooth! ')).toEqual(['fone', 'bluetooth']);
    expect(searchTokens('x')).toEqual(['x']);
    expect(searchTokens('')).toEqual([]);
    expect(searchTokens(undefined)).toEqual([]);
  });

  it('stems a trailing plural "s" on longer words only', () => {
    expect(searchTokens('Fones tênis gás')).toEqual(['fone', 'teni', 'gas']);
  });

  it('caps the number of words and the query length', () => {
    expect(searchTokens('a1 b2 c3 d4 e5 f6 g7 h8 i9 j10')).toHaveLength(8);
    expect(searchTokens(`${'a'.repeat(150)}`)[0]).toHaveLength(100);
  });
});
