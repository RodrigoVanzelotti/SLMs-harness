import { describe, expect, it } from 'vitest';
import { isCardExpired } from '@amazon-mvp/api-contract';

describe('isCardExpired', () => {
  const mid2026 = new Date(2026, 4, 15, 12, 0, 0); // 15 May 2026, local time

  it('keeps a card valid through its whole expiry month', () => {
    expect(isCardExpired({ expMonth: 5, expYear: 2026 }, mid2026)).toBe(false);
    expect(isCardExpired({ expMonth: 6, expYear: 2026 }, mid2026)).toBe(false);
    expect(isCardExpired({ expMonth: 1, expYear: 2027 }, mid2026)).toBe(false);
  });

  it('expires once the month or the year has passed', () => {
    expect(isCardExpired({ expMonth: 4, expYear: 2026 }, mid2026)).toBe(true);
    expect(isCardExpired({ expMonth: 12, expYear: 2025 }, mid2026)).toBe(true);
  });

  it('handles the turn of the year', () => {
    const newYear = new Date(2027, 0, 1, 0, 0, 0);
    expect(isCardExpired({ expMonth: 12, expYear: 2026 }, newYear)).toBe(true);
    expect(isCardExpired({ expMonth: 1, expYear: 2027 }, newYear)).toBe(false);
  });

  it('uses the current date by default', () => {
    const year = new Date().getFullYear();
    expect(isCardExpired({ expMonth: 1, expYear: 2000 })).toBe(true);
    expect(isCardExpired({ expMonth: 12, expYear: year + 1 })).toBe(false);
  });
});
