import { escapeLike } from './catalog-search';

describe('escapeLike', () => {
  it('prefixes each %, _ and backslash with a backslash', () => {
    expect(escapeLike('50%_off\\')).toBe('50\\%\\_off\\\\');
    expect(escapeLike('%%')).toBe('\\%\\%');
    expect(escapeLike('a_b_c')).toBe('a\\_b\\_c');
  });

  it('leaves every other character, including other regex or SQL symbols, unchanged', () => {
    expect(escapeLike('')).toBe('');
    expect(escapeLike('fone bluetooth')).toBe('fone bluetooth');
    expect(escapeLike("it's [a]*.+?")).toBe("it's [a]*.+?");
  });

  it('does not normalize case or accents', () => {
    expect(escapeLike('Câmera')).toBe('Câmera');
  });
});
