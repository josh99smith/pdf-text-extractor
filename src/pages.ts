/**
 * Page-range parsing for the `pageRange` input, e.g. "1-5, 8, 12-".
 *
 * Page numbers are 1-based. An open-ended range ("12-") runs to the last page; a leading dash ("-3") starts at
 * page 1. Ranges are resolved against the real page count of each document, so numbers past the end are simply
 * clamped (never an error), while syntax errors are reported once, at input-validation time.
 */

export interface PageRange {
    /** First page, 1-based, inclusive. */
    from: number;
    /** Last page, 1-based, inclusive; `null` means "to the end of the document". */
    to: number | null;
}

export class PageRangeError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PageRangeError';
    }
}

const TOKEN = /^(\d*)\s*(-)?\s*(\d*)$/;

/**
 * Parses a page-range expression into a normalised, sorted list of non-overlapping ranges.
 * Returns `null` for an empty expression (meaning "all pages"). Throws `PageRangeError` with a user-facing
 * message on invalid syntax.
 */
export function parsePageRange(spec: string | null | undefined): PageRange[] | null {
    const text = (spec ?? '').trim();
    if (!text) return null;

    const ranges: PageRange[] = [];
    for (const rawPart of text.split(/[,;]/)) {
        const part = rawPart.trim();
        if (!part) continue;
        const match = TOKEN.exec(part);
        if (!match) {
            throw new PageRangeError(
                `Invalid page range "${part}". Use 1-based page numbers and ranges separated by commas, e.g. "1-5, 8, 12-".`,
            );
        }
        const [, fromText, dash, toText] = match;
        if (!dash) {
            const page = parsePageNumber(fromText, part);
            ranges.push({ from: page, to: page });
            continue;
        }
        if (!fromText && !toText) {
            throw new PageRangeError(
                `Invalid page range "${part}": a dash needs at least one page number, e.g. "12-".`,
            );
        }
        const from = fromText ? parsePageNumber(fromText, part) : 1;
        const to = toText ? parsePageNumber(toText, part) : null;
        if (to !== null && to < from) {
            throw new PageRangeError(
                `Invalid page range "${part}": the first page (${from}) is greater than the last page (${to}).`,
            );
        }
        ranges.push({ from, to });
    }
    if (ranges.length === 0) return null;
    return mergeRanges(ranges);
}

function parsePageNumber(digits: string, part: string): number {
    const value = Number.parseInt(digits, 10);
    if (!Number.isFinite(value) || value < 1) {
        throw new PageRangeError(`Invalid page range "${part}": page numbers start at 1.`);
    }
    return value;
}

/** Sorts ranges and merges overlapping or adjacent ones. */
export function mergeRanges(ranges: PageRange[]): PageRange[] {
    const sorted = [...ranges].sort((a, b) => a.from - b.from);
    const merged: PageRange[] = [];
    for (const range of sorted) {
        const last = merged[merged.length - 1];
        if (last && (last.to === null || range.from <= last.to + 1)) {
            if (last.to !== null) last.to = range.to === null ? null : Math.max(last.to, range.to);
        } else {
            merged.push({ ...range });
        }
    }
    return merged;
}

/**
 * Resolves ranges against a document: returns the sorted list of 1-based page numbers to extract, clamped to
 * `pageCount` and capped at `maxPages` pages in total. `null` ranges select all pages.
 */
export function resolvePages(ranges: PageRange[] | null, pageCount: number, maxPages: number): number[] {
    const limit = Math.max(Math.floor(maxPages), 0);
    const pages: number[] = [];
    if (pageCount <= 0 || limit === 0) return pages;
    const effective = ranges ?? [{ from: 1, to: null }];
    for (const range of effective) {
        const from = Math.max(range.from, 1);
        const to = Math.min(range.to ?? pageCount, pageCount);
        for (let page = from; page <= to; page++) {
            pages.push(page);
            if (pages.length >= limit) return pages;
        }
    }
    return pages;
}

/** Human-readable form of a parsed range list, for logs. */
export function formatPageRange(ranges: PageRange[] | null): string {
    if (!ranges) return 'all';
    return ranges.map((r) => (r.from === r.to ? `${r.from}` : `${r.from}-${r.to ?? ''}`)).join(', ');
}
