import {
  ACCENTED,
  PLAIN,
  containsPattern,
  escapeLike,
  normalizeText,
  searchTokens,
} from './catalog-search';

describe('catalog search tokens', () => {
  it('folds case and accents like the SQL translate() it is compared with', () => {
    expect(normalizeText('Fritadeira ELÉTRICA Câmera Ação')).toBe(
      'fritadeira eletrica camera acao',
    );
    expect(ACCENTED).toHaveLength(PLAIN.length);
    // Every accented character maps to exactly what normalizeText produces.
    [...ACCENTED].forEach((char, index) => expect(normalizeText(char)).toBe(PLAIN[index]));
  });
});
