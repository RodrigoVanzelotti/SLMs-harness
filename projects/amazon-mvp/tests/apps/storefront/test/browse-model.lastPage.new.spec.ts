import { describe, expect, it } from 'vitest';
import { lastPage } from '../src/features/browse/browse-model';

describe('lastPage', () => {
  it('rounds up to whole pages and is never below 1', () => {
    expect(lastPage(150, 48)).toBe(4);
    expect(lastPage(48, 48)).toBe(1);
    expect(lastPage(49, 48)).toBe(2);
    expect(lastPage(1, 48)).toBe(1);
    expect(lastPage(0, 48)).toBe(1);
  });
});
