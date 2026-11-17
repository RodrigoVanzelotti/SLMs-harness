import { publicName, summarize } from './review-rules';

const listing = (listingKey: string, ratingCount: number, average: number, distribution: number[] = []) => ({
  listingKey,
  ratingCount,
  ratingSum: Math.round(average * ratingCount),
  distribution,
});

describe('publicName', () => {
  it('shows first name and last initial only', () => {
    expect(publicName('Camila Souza Lima')).toBe('Camila L.');
    expect(publicName('  Rafael  ')).toBe('Rafael');
    expect(publicName('ana maria')).toBe('ana M.');
    expect(publicName('   ')).toBe('Cliente Amazon');
  });
});
