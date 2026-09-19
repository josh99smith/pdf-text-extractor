import { describe, expect, it } from 'vitest';

import { chunkPages, DEFAULT_MAX_CHUNKS, MIN_CHUNK_SIZE, normalizeChunkOptions } from '../src/chunk.js';

const paragraph = (n: number, words = 40) =>
    Array.from({ length: words }, (_, i) => `p${n}w${i}`)
        .join(' ')
        .replace(/(w9|w19|w29)\b/g, '$1.');

describe('normalizeChunkOptions', () => {
    it('enforces the minimum chunk size and caps overlap at half the chunk size', () => {
        expect(normalizeChunkOptions({ chunkSize: 10, chunkOverlap: 200 })).toEqual({
            chunkSize: MIN_CHUNK_SIZE,
            chunkOverlap: MIN_CHUNK_SIZE / 2,
            maxChunks: DEFAULT_MAX_CHUNKS,
        });
        expect(normalizeChunkOptions({ chunkSize: 1500, chunkOverlap: -5, maxChunks: 10 })).toEqual({
            chunkSize: 1500,
            chunkOverlap: 0,
            maxChunks: 10,
        });
    });
});

describe('chunkPages', () => {
    it('returns no chunks for empty documents and skips blank pages', () => {
        expect(chunkPages([], { chunkSize: 500, chunkOverlap: 50 })).toEqual([]);
        expect(chunkPages([{ page: 1, text: '   \n\n ' }], { chunkSize: 500, chunkOverlap: 50 })).toEqual([]);
        const chunks = chunkPages(
            [
                { page: 1, text: '' },
                { page: 2, text: 'Only this page has text.' },
            ],
            { chunkSize: 500, chunkOverlap: 50 },
        );
        expect(chunks).toEqual([{ index: 0, page: 2, text: 'Only this page has text.', charCount: 24 }]);
    });

    it('keeps short documents as a single chunk', () => {
        const chunks = chunkPages([{ page: 1, text: 'Hello world.' }], { chunkSize: 1000, chunkOverlap: 200 });
        expect(chunks).toHaveLength(1);
        expect(chunks[0]).toMatchObject({ index: 0, page: 1, text: 'Hello world.', charCount: 12 });
    });

    it('never exceeds chunkSize and prefers paragraph boundaries', () => {
        const text = [paragraph(1), paragraph(2), paragraph(3), paragraph(4)].join('\n\n');
        const chunks = chunkPages([{ page: 1, text }], { chunkSize: 600, chunkOverlap: 0 });
        expect(chunks.length).toBeGreaterThan(1);
        for (const chunk of chunks) {
            expect(chunk.charCount).toBeLessThanOrEqual(600);
            expect(chunk.text).toBe(chunk.text.trim());
            // Each chunk ends where a paragraph ends (a paragraph is ~280 chars, so two fit in 600).
            expect(chunk.text).toMatch(/w39\.?$/);
        }
        // Without overlap the chunks reproduce the whole text.
        expect(chunks.map((c) => c.text).join('\n\n')).toBe(text);
        expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
    });

    it('falls back to sentence and word boundaries and never splits inside a word', () => {
        const words = Array.from({ length: 300 }, (_, i) => `word${i}`).join(' ');
        const chunks = chunkPages([{ page: 1, text: words }], { chunkSize: 200, chunkOverlap: 0 });
        expect(chunks.length).toBeGreaterThan(5);
        for (const chunk of chunks) {
            expect(chunk.charCount).toBeLessThanOrEqual(200);
            expect(chunk.text).toMatch(/^word\d+( word\d+)*$/);
        }
        expect(chunks.map((c) => c.text).join(' ')).toBe(words);
    });

    it('hard-cuts tokens longer than chunkSize and still terminates', () => {
        const long = 'x'.repeat(1000);
        const chunks = chunkPages([{ page: 1, text: long }], { chunkSize: 300, chunkOverlap: 100 });
        expect(chunks.length).toBeGreaterThan(3);
        expect(chunks.every((c) => c.charCount <= 300)).toBe(true);
        expect(chunks[chunks.length - 1].text.endsWith('x')).toBe(true);
    });

    it('overlaps consecutive chunks by roughly chunkOverlap characters at a word boundary', () => {
        const words = Array.from({ length: 400 }, (_, i) => `w${i}`).join(' ');
        const chunks = chunkPages([{ page: 1, text: words }], { chunkSize: 300, chunkOverlap: 60 });
        expect(chunks.length).toBeGreaterThan(3);
        for (let i = 1; i < chunks.length; i++) {
            const prev = chunks[i - 1].text;
            const current = chunks[i].text;
            const firstWord = current.split(' ')[0];
            // The next chunk starts inside the tail of the previous one, on a whole word.
            expect(prev.endsWith(current.slice(0, prev.length - prev.lastIndexOf(firstWord)))).toBe(true);
            const overlap = prev.length - prev.lastIndexOf(firstWord);
            expect(overlap).toBeGreaterThan(0);
            expect(overlap).toBeLessThanOrEqual(60);
        }
        // Every word is still covered.
        const covered = new Set(chunks.flatMap((c) => c.text.split(' ')));
        expect(covered.size).toBe(400);
    });

    it('attributes each chunk to the page on which it starts', () => {
        const pages = [
            { page: 1, text: paragraph(1) },
            { page: 3, text: paragraph(3) },
            { page: 7, text: paragraph(7) },
        ];
        const chunks = chunkPages(pages, { chunkSize: 300, chunkOverlap: 0 });
        expect(chunks.map((c) => c.page)).toEqual([1, 3, 7]);
        expect(chunks[1].text.startsWith('p3w0')).toBe(true);
    });

    it('caps the number of chunks', () => {
        const words = Array.from({ length: 2000 }, (_, i) => `w${i}`).join(' ');
        const chunks = chunkPages([{ page: 1, text: words }], { chunkSize: 100, chunkOverlap: 0, maxChunks: 5 });
        expect(chunks).toHaveLength(5);
    });
});
