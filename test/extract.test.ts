import { readFileSync } from 'node:fs';

import type { TextItem } from 'pdfjs-dist/types/src/display/api.js';
import { describe, expect, it } from 'vitest';

import { PdfError } from '../src/download.js';
import {
    buildLines,
    buildMetadata,
    buildParagraphs,
    capText,
    countWords,
    estimateBodyFontSize,
    extractPdf,
    extractUrlsFromText,
    joinLines,
    PAGE_BREAK_MARKDOWN,
    parsePdfDate,
    renderPageMarkdown,
    renderPageText,
    uniqueLinks,
} from '../src/extract.js';
import { parsePageRange } from '../src/pages.js';

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

/** Builds a pdf.js-like text item at (x, y) with the given font size. */
function item(str: string, x: number, y: number, size = 10, hasEOL = false): TextItem {
    return {
        str,
        dir: 'ltr',
        width: str.length * size * 0.5,
        height: size,
        transform: [size, 0, 0, size, x, y],
        fontName: 'f1',
        hasEOL,
    };
}

describe('buildLines', () => {
    it('joins items on the same baseline and inserts spaces for visible gaps', () => {
        const lines = buildLines([item('Hello', 10, 700), item('world', 40, 700), item('!', 65, 700)]);
        expect(lines.map((l) => l.text)).toEqual(['Hello world!']);
    });

    it('starts a new line on a baseline change or an EOL flag', () => {
        const lines = buildLines([item('One', 10, 700, 10, true), item('Two', 10, 700), item('Three', 10, 680)]);
        expect(lines.map((l) => l.text)).toEqual(['One', 'Two', 'Three']);
    });

    it('drops empty items but honours their EOL flags', () => {
        const lines = buildLines([item('A', 10, 700), item('', 20, 700, 10, true), item('B', 30, 700)]);
        expect(lines.map((l) => l.text)).toEqual(['A', 'B']);
    });
});

describe('buildParagraphs / joinLines', () => {
    it('merges consecutive lines and splits on large vertical gaps', () => {
        const lines = buildLines([
            item('First line of a', 10, 700),
            item('paragraph.', 10, 688),
            item('New paragraph after a gap.', 10, 650),
        ]);
        const paragraphs = buildParagraphs(lines);
        expect(paragraphs.map((p) => p.text)).toEqual(['First line of a paragraph.', 'New paragraph after a gap.']);
    });

    it('splits on font size changes so headings become their own paragraph', () => {
        const lines = buildLines([
            item('Title', 10, 700, 20),
            item('Body text', 10, 680, 10),
            item('continues', 10, 668, 10),
        ]);
        const paragraphs = buildParagraphs(lines);
        expect(paragraphs.map((p) => p.text)).toEqual(['Title', 'Body text continues']);
        expect(paragraphs[0].fontSize).toBe(20);
    });

    it('starts a new paragraph when the text moves back up the page (new column)', () => {
        const lines = buildLines([
            item('Left column', 10, 700),
            item('Right column', 300, 700),
            item('Bottom', 10, 688),
        ]);
        // Same baseline, so the first two are one line; a baseline change then starts a new line/paragraph.
        expect(buildParagraphs(lines).map((p) => p.text)).toEqual(['Left column Right column Bottom']);
        const columns = buildLines([item('Left bottom', 10, 100), item('Right top', 300, 700)]);
        expect(buildParagraphs(columns).map((p) => p.text)).toEqual(['Left bottom', 'Right top']);
    });

    it('repairs end-of-line hyphenation without destroying real hyphens', () => {
        expect(joinLines(['posi-', 'tion'])).toBe('position');
        expect(joinLines(['English-', 'to-German'])).toBe('English- to-German');
        expect(joinLines(['ISO-', 'Norm'])).toBe('ISO- Norm');
        expect(joinLines(['a', 'b'])).toBe('a b');
    });
});

describe('links', () => {
    it('extracts http and www URLs from text and trims trailing punctuation', () => {
        const urls = extractUrlsFromText('See https://example.com/a). Also www.example.org/x, and http://x.io/y?z=1.');
        expect(urls).toEqual(['https://example.com/a', 'www.example.org/x', 'http://x.io/y?z=1']);
    });

    it('deduplicates links while preserving order', () => {
        expect(
            uniqueLinks([
                ['a', 'b'],
                ['b', 'c', ' a '],
            ]),
        ).toEqual(['a', 'b', 'c']);
    });
});

describe('rendering helpers', () => {
    const page = {
        page: 1,
        links: [],
        paragraphs: [
            { text: 'Big Title', fontSize: 20 },
            { text: 'Sub heading', fontSize: 13 },
            { text: 'Body paragraph one.', fontSize: 10 },
            { text: 'Body paragraph two, long enough to matter for the median.', fontSize: 10 },
        ],
    };

    it('renders plain text with blank lines between paragraphs', () => {
        expect(renderPageText(page)).toBe(
            'Big Title\n\nSub heading\n\nBody paragraph one.\n\nBody paragraph two, long enough to matter for the median.',
        );
    });

    it('guesses heading levels from font size relative to the body size', () => {
        const body = estimateBodyFontSize([page]);
        expect(body).toBe(10);
        expect(renderPageMarkdown(page, body)).toBe(
            '# Big Title\n\n## Sub heading\n\nBody paragraph one.\n\nBody paragraph two, long enough to matter for the median.',
        );
        expect(PAGE_BREAK_MARKDOWN).toBe('\n\n---\n\n');
    });

    it('counts words across scripts', () => {
        expect(countWords('Hello, world! Ça va? 123 state-of-the-art')).toBe(6);
        expect(countWords('')).toBe(0);
        expect(countWords('   \n ')).toBe(0);
    });

    it('caps text by UTF-8 byte size at a word boundary', () => {
        const short = capText('hello', 100);
        expect(short).toEqual({ text: 'hello', truncated: false });
        const long = capText('word '.repeat(1000), 1000);
        expect(long.truncated).toBe(true);
        expect(long.text.endsWith('[truncated]')).toBe(true);
        expect(Buffer.byteLength(long.text.replace('\n\n[truncated]', ''), 'utf8')).toBeLessThanOrEqual(1000);
        const multibyte = capText('é'.repeat(100), 51);
        expect(multibyte.text.includes('�')).toBe(false);
    });
});

describe('metadata', () => {
    it('parses PDF date strings into ISO timestamps', () => {
        expect(parsePdfDate("D:20090324113315-06'00'")).toBe('2009-03-24T17:33:15.000Z');
        expect(parsePdfDate('D:20240102030405Z')).toBe('2024-01-02T03:04:05.000Z');
        expect(parsePdfDate('')).toBeNull();
        expect(parsePdfDate(undefined)).toBeNull();
    });

    it('falls back to XMP values and flags encryption', () => {
        const xmp = { get: (name: string) => (name === 'dc:title' ? 'XMP title' : null) };
        const meta = buildMetadata({ Author: '  Ann ', EncryptFilterName: 'Standard', PDFFormatVersion: '1.7' }, xmp);
        expect(meta.title).toBe('XMP title');
        expect(meta.author).toBe('Ann');
        expect(meta.encrypted).toBe(true);
        expect(meta.pdfVersion).toBe('1.7');
        expect(meta.subject).toBeNull();
        expect(buildMetadata({}, null).encrypted).toBe(false);
    });
});

describe('extractPdf (fixtures, no network)', () => {
    it('extracts the text of the W3C dummy PDF', async () => {
        const result = await extractPdf(fixture('dummy.pdf'), { maxPages: 500, extractLinks: true });
        expect(result.pageCount).toBe(1);
        expect(result.pagesExtracted).toBe(1);
        expect(renderPageText(result.pages[0])).toBe('Dummy PDF file');
        expect(result.metadata.author).toBe('Evangelos Vlachogiannis');
        expect(result.metadata.pdfVersion).toBe('1.4');
        expect(result.metadata.creationDate).toBe('2007-02-23T15:56:37.000Z');
        expect(result.metadata.encrypted).toBe(false);
    });

    it('extracts per-page text, metadata, annotation links and text links from a multi-page PDF', async () => {
        const result = await extractPdf(fixture('three-pages.pdf'), { maxPages: 500, extractLinks: true });
        expect(result.pageCount).toBe(3);
        expect(result.pagesExtracted).toBe(3);
        expect(result.metadata).toMatchObject({
            title: 'Fixture Title',
            author: 'Test Author',
            subject: 'Testing',
            keywords: 'a, b',
            creator: 'handmade',
            producer: 'python',
            creationDate: '2024-01-02T03:04:05.000Z',
        });
        const page1 = renderPageText(result.pages[0]);
        expect(page1.startsWith('Chapter One')).toBe(true);
        expect(page1).toContain('A hyphenated word continues here.');
        expect(result.pages[0].links).toEqual([
            'https://example.com/annotated',
            'https://example.com/in-text',
            'www.example.org/path',
        ]);
        expect(renderPageText(result.pages[2])).toBe('Chapter Three\n\nThird and final page.');
        expect(renderPageMarkdown(result.pages[1], result.bodyFontSize)).toMatch(/^# Chapter Two/);
    });

    it('honours maxPages and skips link extraction when disabled', async () => {
        const result = await extractPdf(fixture('three-pages.pdf'), { maxPages: 2, extractLinks: false });
        expect(result.pageCount).toBe(3);
        expect(result.pagesExtracted).toBe(2);
        expect(result.pages).toHaveLength(2);
        expect(result.pages[0].links).toEqual([]);
    });

    it('returns empty text for a PDF without a text layer', async () => {
        const result = await extractPdf(fixture('no-text.pdf'), { maxPages: 500, extractLinks: true });
        expect(result.pageCount).toBe(1);
        expect(renderPageText(result.pages[0])).toBe('');
        expect(countWords(renderPageText(result.pages[0]))).toBe(0);
    });

    it('fails with "encrypted" for password-protected PDFs', async () => {
        await expect(extractPdf(fixture('encrypted.pdf'), { maxPages: 500, extractLinks: true })).rejects.toMatchObject(
            {
                errorType: 'encrypted',
            },
        );
    });

    it('opens password-protected PDFs when the right password is supplied', async () => {
        const result = await extractPdf(fixture('encrypted.pdf'), {
            maxPages: 500,
            extractLinks: true,
            password: 'secret',
        });
        expect(result.pageCount).toBeGreaterThan(0);
        expect(result.metadata.encrypted).toBe(true);
        expect(renderPageText(result.pages[0]).length).toBeGreaterThan(0);
    });

    it('fails with "encrypted" and a "password rejected" message for a wrong password', async () => {
        await expect(
            extractPdf(fixture('encrypted.pdf'), { maxPages: 500, extractLinks: true, password: 'wrong' }),
        ).rejects.toMatchObject({ errorType: 'encrypted', message: expect.stringMatching(/password was rejected/) });
    });

    it('ignores an empty password and reports how to open the file', async () => {
        await expect(
            extractPdf(fixture('encrypted.pdf'), { maxPages: 500, extractLinks: true, password: '' }),
        ).rejects.toMatchObject({ errorType: 'encrypted', message: expect.stringMatching(/set the "password" input/) });
    });

    it('extracts only the pages selected by pageRanges and reports their real page numbers', async () => {
        const result = await extractPdf(fixture('three-pages.pdf'), {
            maxPages: 500,
            extractLinks: false,
            pageRanges: parsePageRange('3, 1, 10-'),
        });
        expect(result.pageCount).toBe(3);
        expect(result.pagesExtracted).toBe(2);
        expect(result.pages.map((p) => p.page)).toEqual([1, 3]);
        expect(renderPageText(result.pages[1])).toBe('Chapter Three\n\nThird and final page.');
    });

    it('returns no pages when the range lies past the end of the document', async () => {
        const result = await extractPdf(fixture('three-pages.pdf'), {
            maxPages: 500,
            extractLinks: false,
            pageRanges: parsePageRange('5-'),
        });
        expect(result.pageCount).toBe(3);
        expect(result.pagesExtracted).toBe(0);
        expect(result.pages).toEqual([]);
    });

    it('applies maxPages on top of pageRanges', async () => {
        const result = await extractPdf(fixture('three-pages.pdf'), {
            maxPages: 1,
            extractLinks: false,
            pageRanges: parsePageRange('2-'),
        });
        expect(result.pages.map((p) => p.page)).toEqual([2]);
    });

    it('opens owner-password-only PDFs and flags them as encrypted', async () => {
        const result = await extractPdf(fixture('owner-only.pdf'), { maxPages: 500, extractLinks: true });
        expect(result.metadata.encrypted).toBe(true);
        expect(renderPageText(result.pages[0])).toBe('Dummy PDF file');
    });

    it('fails with "parse-error" for corrupted files', async () => {
        const garbage = new TextEncoder().encode('%PDF-1.4\nthis is not really a pdf\n');
        try {
            await extractPdf(garbage, { maxPages: 500, extractLinks: true });
            throw new Error('expected failure');
        } catch (error) {
            expect(error).toBeInstanceOf(PdfError);
            expect((error as PdfError).errorType).toBe('parse-error');
        }
    });
});
