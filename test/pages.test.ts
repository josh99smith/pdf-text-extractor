import { describe, expect, it } from 'vitest';

import { formatPageRange, mergeRanges, PageRangeError, parsePageRange, resolvePages } from '../src/pages.js';

describe('parsePageRange', () => {
    it('returns null for empty, blank or missing input (all pages)', () => {
        expect(parsePageRange('')).toBeNull();
        expect(parsePageRange('   ')).toBeNull();
        expect(parsePageRange(undefined)).toBeNull();
        expect(parsePageRange(null)).toBeNull();
        expect(parsePageRange(', ,')).toBeNull();
    });

    it('parses single pages, closed ranges and open-ended ranges', () => {
        expect(parsePageRange('1-5, 8, 12-')).toEqual([
            { from: 1, to: 5 },
            { from: 8, to: 8 },
            { from: 12, to: null },
        ]);
    });

    it('tolerates whitespace, semicolons and spaces around dashes', () => {
        expect(parsePageRange('  3 ;  7 -  9 ,11-')).toEqual([
            { from: 3, to: 3 },
            { from: 7, to: 9 },
            { from: 11, to: null },
        ]);
    });

    it('treats a leading dash as "from page 1"', () => {
        expect(parsePageRange('-3')).toEqual([{ from: 1, to: 3 }]);
    });

    it('sorts and merges duplicates, overlaps and adjacent ranges', () => {
        expect(parsePageRange('8, 1-3, 2-5, 8, 6, 20-, 25-30')).toEqual([
            { from: 1, to: 6 },
            { from: 8, to: 8 },
            { from: 20, to: null },
        ]);
    });

    it('rejects invalid syntax with a friendly message', () => {
        expect(() => parsePageRange('abc')).toThrow(PageRangeError);
        expect(() => parsePageRange('1-2-3')).toThrow(/Invalid page range "1-2-3"/);
        expect(() => parsePageRange('1..5')).toThrow(/e\.g\. "1-5, 8, 12-"/);
        expect(() => parsePageRange('-')).toThrow(/needs at least one page number/);
    });

    it('rejects page 0 and reversed ranges', () => {
        expect(() => parsePageRange('0')).toThrow(/page numbers start at 1/);
        expect(() => parsePageRange('0-5')).toThrow(/page numbers start at 1/);
        expect(() => parsePageRange('5-3')).toThrow(/first page \(5\) is greater than the last page \(3\)/);
    });
});

describe('mergeRanges', () => {
    it('keeps open-ended ranges open when merging', () => {
        expect(
            mergeRanges([
                { from: 5, to: null },
                { from: 1, to: 10 },
            ]),
        ).toEqual([{ from: 1, to: null }]);
        expect(
            mergeRanges([
                { from: 1, to: 2 },
                { from: 4, to: null },
                { from: 6, to: 7 },
            ]),
        ).toEqual([
            { from: 1, to: 2 },
            { from: 4, to: null },
        ]);
    });
});

describe('resolvePages', () => {
    it('selects every page when no range is given, capped by maxPages', () => {
        expect(resolvePages(null, 4, 500)).toEqual([1, 2, 3, 4]);
        expect(resolvePages(null, 4, 2)).toEqual([1, 2]);
        expect(resolvePages(null, 0, 500)).toEqual([]);
    });

    it('expands ranges into sorted page numbers and clamps to the page count', () => {
        const ranges = parsePageRange('1-2, 5, 8-');
        expect(resolvePages(ranges, 10, 500)).toEqual([1, 2, 5, 8, 9, 10]);
        expect(resolvePages(ranges, 6, 500)).toEqual([1, 2, 5]);
        expect(resolvePages(ranges, 1, 500)).toEqual([1]);
    });

    it('returns an empty list when the range lies entirely past the end of the document', () => {
        expect(resolvePages(parsePageRange('50-60'), 9, 500)).toEqual([]);
    });

    it('applies maxPages as a cap on the total number of selected pages', () => {
        expect(resolvePages(parsePageRange('1-2, 5, 8-'), 10, 4)).toEqual([1, 2, 5, 8]);
        expect(resolvePages(parsePageRange('3-'), 100, 3)).toEqual([3, 4, 5]);
    });
});

describe('formatPageRange', () => {
    it('renders ranges for logs', () => {
        expect(formatPageRange(null)).toBe('all');
        expect(formatPageRange(parsePageRange('1-5, 8, 12-'))).toBe('1-5, 8, 12-');
    });
});
