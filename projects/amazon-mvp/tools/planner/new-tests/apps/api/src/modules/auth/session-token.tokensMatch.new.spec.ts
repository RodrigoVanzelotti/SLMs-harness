import { tokensMatch } from './session-token';

describe('tokensMatch', () => {
  it('is true only for byte-identical strings', () => {
    expect(tokensMatch('abc123', 'abc123')).toBe(true);
    expect(tokensMatch('', '')).toBe(true);
    expect(tokensMatch('abc123', 'abc124')).toBe(false);
    expect(tokensMatch('abc123', 'ABC123')).toBe(false);
  });

  it('returns false for different lengths instead of throwing', () => {
    expect(tokensMatch('abc', 'abcd')).toBe(false);
    expect(tokensMatch('abcd', 'abc')).toBe(false);
    expect(tokensMatch('', 'a')).toBe(false);
  });

  it('compares UTF-8 bytes, so equal-looking strings of different byte length differ', () => {
    expect(tokensMatch('é', 'é')).toBe(true);
    expect(tokensMatch('é', 'e')).toBe(false);
    expect(tokensMatch('é', 'é')).toBe(false);
  });
});
