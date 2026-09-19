/**
 * Splits extracted page text into overlapping, size-bounded chunks for embedding / RAG pipelines.
 *
 * The chunker works on the concatenated text of the extracted pages and prefers to cut at paragraph boundaries
 * (blank lines), then line breaks, then sentence ends, then spaces, before falling back to a hard cut. Each chunk
 * records the page on which it starts.
 */

export interface ChunkInput {
    /** 1-based page number. */
    page: number;
    text: string;
}

export interface Chunk {
    /** 0-based position of the chunk in the document. */
    index: number;
    /** 1-based page on which the chunk starts. */
    page: number;
    text: string;
    charCount: number;
}

export interface ChunkOptions {
    /** Maximum characters per chunk. */
    chunkSize: number;
    /** Characters of the previous chunk repeated at the start of the next one. */
    chunkOverlap: number;
    /** Hard cap on the number of chunks returned. */
    maxChunks?: number;
}

export const DEFAULT_MAX_CHUNKS = 2000;
export const MIN_CHUNK_SIZE = 100;

const PAGE_SEPARATOR = '\n\n';

/** Clamps user-supplied sizes to sane values: chunkSize >= MIN_CHUNK_SIZE, 0 <= overlap <= chunkSize / 2. */
export function normalizeChunkOptions(options: ChunkOptions): Required<ChunkOptions> {
    const chunkSize = Math.max(Math.floor(options.chunkSize), MIN_CHUNK_SIZE);
    const chunkOverlap = Math.min(Math.max(Math.floor(options.chunkOverlap), 0), Math.floor(chunkSize / 2));
    const maxChunks = Math.max(Math.floor(options.maxChunks ?? DEFAULT_MAX_CHUNKS), 1);
    return { chunkSize, chunkOverlap, maxChunks };
}

/** Builds overlapping chunks from page texts. Pages without text are skipped; an empty document yields no chunks. */
export function chunkPages(pages: ChunkInput[], options: ChunkOptions): Chunk[] {
    const { chunkSize, chunkOverlap, maxChunks } = normalizeChunkOptions(options);

    // Concatenate pages, remembering where each page starts so a chunk can be attributed to a page.
    const pageStarts: { offset: number; page: number }[] = [];
    let full = '';
    for (const page of pages) {
        const text = page.text.trim();
        if (!text) continue;
        if (full) full += PAGE_SEPARATOR;
        pageStarts.push({ offset: full.length, page: page.page });
        full += text;
    }
    if (!full) return [];

    const chunks: Chunk[] = [];
    let start = 0;
    while (start < full.length && chunks.length < maxChunks) {
        // Skip leading whitespace so chunks never start with a blank line.
        while (start < full.length && /\s/.test(full[start])) start++;
        if (start >= full.length) break;

        const end = findChunkEnd(full, start, chunkSize);
        const text = full.slice(start, end).trimEnd();
        if (text) {
            chunks.push({ index: chunks.length, page: pageAt(pageStarts, start), text, charCount: text.length });
        }
        if (end >= full.length) break;

        // Start the next chunk `chunkOverlap` characters back, moved forward to a whitespace boundary so the
        // overlap never begins mid-word; always make progress even when the overlap covers the whole chunk.
        let next = end - chunkOverlap;
        if (chunkOverlap > 0) {
            const boundary = full.slice(next, end).search(/\s/);
            next = boundary >= 0 ? next + boundary : end;
        }
        start = Math.max(next, start + 1);
    }
    return chunks;
}

/** Finds the exclusive end offset of a chunk starting at `start`, preferring natural boundaries. */
function findChunkEnd(text: string, start: number, chunkSize: number): number {
    const limit = start + chunkSize;
    if (limit >= text.length) return text.length;
    const window = text.slice(start, limit);
    // Do not cut too early: only accept a boundary in the second half of the window.
    const minimum = Math.floor(chunkSize / 2);

    const candidates: { pattern: RegExp; keepDelimiter: boolean }[] = [
        { pattern: /\n\s*\n/g, keepDelimiter: false }, // paragraph break
        { pattern: /\n/g, keepDelimiter: false }, // line break
        { pattern: /[.!?]["')\]]?\s/g, keepDelimiter: true }, // sentence end
        { pattern: /\s/g, keepDelimiter: false }, // word boundary
    ];
    for (const { pattern, keepDelimiter } of candidates) {
        let best = -1;
        for (const match of window.matchAll(pattern)) {
            const cut = keepDelimiter ? match.index + match[0].length : match.index;
            if (cut >= minimum) best = cut;
        }
        if (best > 0) return start + best;
    }
    return limit; // hard cut inside a very long token
}

function pageAt(pageStarts: { offset: number; page: number }[], offset: number): number {
    let page = pageStarts[0]?.page ?? 1;
    for (const entry of pageStarts) {
        if (entry.offset <= offset) page = entry.page;
        else break;
    }
    return page;
}
