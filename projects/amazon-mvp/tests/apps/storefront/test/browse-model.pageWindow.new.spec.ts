import { describe, expect, it } from 'vitest';
import { pageWindow } from '../src/features/browse/browse-model';

describe('pageWindow', () => {
  it('keeps the first, last, current and neighbouring pages with gaps between', () => {
    expect(pageWindow(10, 20)).toEqual([1, 'gap', 9, 10, 11, 'gap', 20]);
    expect(pageWindow(5, 9)).toEqual([1, 'gap', 4, 5, 6, 'gap', 9]);
    expect(pageWindow(1, 20)).toEqual([1, 2, 'gap', 20]);
    expect(pageWindow(20, 20)).toEqual([1, 'gap', 19, 20]);
  });

  it('shows a single skipped page instead of a gap', () => {
    expect(pageWindow(3, 20)).toEqual([1, 2, 3, 4, 'gap', 20]);
    expect(pageWindow(4, 20)).toEqual([1, 2, 3, 4, 5, 'gap', 20]);
    expect(pageWindow(17, 20)).toEqual([1, 'gap', 16, 17, 18, 19, 20]);
  });

  it('lists short ranges in full', () => {
    expect(pageWindow(1, 1)).toEqual([1]);
    expect(pageWindow(1, 2)).toEqual([1, 2]);
    expect(pageWindow(1, 4)).toEqual([1, 2, 3, 4]);
  });

  it('drops pages outside 1..last', () => {
    expect(pageWindow(25, 20)).toEqual([1, 'gap', 20]);
  });
});
