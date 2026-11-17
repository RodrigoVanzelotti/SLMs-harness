import { normalizeEmail } from './users.api';

describe('normalizeEmail', () => {
  it('trims surrounding whitespace and lowercases', () => {
    expect(normalizeEmail('  Ada@Example.COM ')).toBe('ada@example.com');
    expect(normalizeEmail('\tADA@EXAMPLE.COM\n')).toBe('ada@example.com');
  });

  it('leaves an already canonical address unchanged', () => {
    expect(normalizeEmail('ada@example.com')).toBe('ada@example.com');
  });

  it('does not touch inner characters other than case', () => {
    expect(normalizeEmail('Ada.Love+Shop@Example.com')).toBe('ada.love+shop@example.com');
    expect(normalizeEmail('a b@example.com')).toBe('a b@example.com');
  });
});
