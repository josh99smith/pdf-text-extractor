import type { PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { TextItem } from 'pdfjs-dist/types/src/display/api.js';

import { PdfError } from './download.js';
import { pdfjs } from './pdfjs.js';

export interface PdfMetadata {
    title: string | null;
    author: string | null;
    subject: string | null;
    keywords: string | null;
    creator: string | null;
    producer: string | null;
    creationDate: string | null;
    modDate: string | null;
    pdfVersion: string | null;
    encrypted: boolean;
}

export interface Paragraph {
    text: string;
    fontSize: number;
}

export interface PageResult {
    page: number;
    paragraphs: Paragraph[];
    links: string[];
}

export interface ExtractOptions {
    maxPages: number;
    extractLinks: boolean;
}

export interface ExtractResult {
    pageCount: number;
    pagesExtracted: number;
    metadata: PdfMetadata;
    pages: PageResult[];
    /** Body font size estimated across the document; used for heading detection in Markdown. */
    bodyFontSize: number;
}

export const PAGE_BREAK_MARKDOWN = '\n\n---\n\n';
export const PAGE_BREAK_TEXT = '\n\n';

/* ------------------------------------------------------------------ */
/* Layout: text items -> lines -> paragraphs                           */
/* ------------------------------------------------------------------ */

interface Line {
    text: string;
    x: number;
    y: number;
    fontSize: number;
    endsWithEol: boolean;
}

function itemFontSize(item: TextItem): number {
    const [a, b, c, d] = item.transform;
    const fromMatrix = Math.max(Math.hypot(a, b), Math.hypot(c, d));
    const size = item.height > 0 ? item.height : fromMatrix;
    return Number.isFinite(size) && size > 0 ? size : 10;
}

/** Groups pdf.js text items into lines using EOL flags and vertical position. */
export function buildLines(items: TextItem[]): Line[] {
    const lines: Line[] = [];
    let current: Line | null = null;
    let lastRightEdge = 0;
    let lastEol = false;

    for (const item of items) {
        const str = item.str ?? '';
        const x = item.transform[4];
        const y = item.transform[5];
        const size = itemFontSize(item);

        if (str.length === 0) {
            // Empty items only carry EOL information.
            if (item.hasEOL) lastEol = true;
            continue;
        }

        const sameLine =
            current !== null && !lastEol && Math.abs(y - current.y) <= Math.max(current.fontSize, size) * 0.5;

        if (!sameLine) {
            if (current) lines.push(current);
            current = { text: '', x, y, fontSize: size, endsWithEol: false };
        } else if (current) {
            const gap = x - lastRightEdge;
            const needsSpace =
                gap > size * 0.15 && !/\s$/.test(current.text) && !/^\s/.test(str) && current.text.length > 0;
            if (needsSpace) current.text += ' ';
            if (size > current.fontSize) current.fontSize = size;
        }

        if (current) {
            current.text += str;
            current.endsWithEol = item.hasEOL;
        }
        lastRightEdge = x + (item.width > 0 ? item.width : 0);
        lastEol = item.hasEOL;
    }
    if (current) lines.push(current);

    return lines
        .map((line) => ({ ...line, text: line.text.replace(/[ \t\xa0]+/g, ' ').trim() }))
        .filter((line) => line.text.length > 0);
}

/** Merges lines into paragraphs based on vertical gaps, column changes and font-size changes. */
export function buildParagraphs(lines: Line[]): Paragraph[] {
    const paragraphs: Paragraph[] = [];
    let buffer: string[] = [];
    let bufferSize = 0;
    let prev: Line | null = null;

    const flush = () => {
        if (buffer.length === 0) return;
        paragraphs.push({ text: joinLines(buffer), fontSize: bufferSize });
        buffer = [];
        bufferSize = 0;
    };

    for (const line of lines) {
        if (prev) {
            const lineHeight = Math.max(prev.fontSize, line.fontSize, 1);
            const dy = prev.y - line.y; // positive when moving down the page
            const movedUp = dy < -lineHeight * 0.5; // new column or block
            const bigGap = dy > lineHeight * 1.6;
            const sizeChanged = Math.abs(line.fontSize - prev.fontSize) > Math.max(prev.fontSize, line.fontSize) * 0.15;
            const indentJump = Math.abs(line.x - prev.x) > lineHeight * 6 && dy > lineHeight * 0.5;
            if (movedUp || bigGap || sizeChanged || indentJump) flush();
        }
        buffer.push(line.text);
        bufferSize = Math.max(bufferSize, line.fontSize);
        prev = line;
    }
    flush();
    return paragraphs;
}

/** Joins wrapped lines of one paragraph, repairing simple end-of-line hyphenation. */
export function joinLines(lines: string[]): string {
    let out = '';
    for (const line of lines) {
        if (!out) {
            out = line;
            continue;
        }
        // "posi-" + "tion" -> "position", but keep the hyphen in "English-" + "to-German".
        if (/[a-z]-$/.test(out) && /^[a-z]/.test(line) && !/^[a-z]+-/.test(line)) out = out.slice(0, -1) + line;
        else out += ` ${line}`;
    }
    return out.trim();
}

/* ------------------------------------------------------------------ */
/* Links                                                               */
/* ------------------------------------------------------------------ */

const URL_IN_TEXT = /(?:https?:\/\/|www\.)[^\s<>"'`{}|\\^[\]]+/gi;

/** Extracts http(s) and www. URLs from free text, trimming trailing punctuation. */
export function extractUrlsFromText(text: string): string[] {
    const found: string[] = [];
    for (const match of text.matchAll(URL_IN_TEXT)) {
        let url = match[0];
        url = url.replace(/[.,;:!?)\]}'"]+$/g, '');
        if (url.length < 8) continue;
        found.push(url);
    }
    return found;
}

export function uniqueLinks(lists: string[][]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const list of lists) {
        for (const link of list) {
            const key = link.trim();
            if (!key || seen.has(key)) continue;
            seen.add(key);
            out.push(key);
        }
    }
    return out;
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

export function renderPageText(page: PageResult): string {
    return page.paragraphs.map((p) => p.text).join('\n\n');
}

export function renderPageMarkdown(page: PageResult, bodyFontSize: number): string {
    return page.paragraphs
        .map((p) => {
            const level = headingLevel(p, bodyFontSize);
            return level ? `${'#'.repeat(level)} ${p.text}` : p.text;
        })
        .join('\n\n');
}

function headingLevel(paragraph: Paragraph, bodyFontSize: number): number {
    if (bodyFontSize <= 0) return 0;
    const ratio = paragraph.fontSize / bodyFontSize;
    const { text } = paragraph;
    if (text.length > 160 || /[.:;,]$/.test(text)) return 0;
    if (ratio >= 1.6) return 1;
    if (ratio >= 1.25) return 2;
    if (ratio >= 1.12 && text.length <= 80) return 3;
    return 0;
}

/** Character-weighted median font size across all paragraphs. */
export function estimateBodyFontSize(pages: PageResult[]): number {
    const weights = new Map<number, number>();
    for (const page of pages) {
        for (const p of page.paragraphs) {
            const key = Math.round(p.fontSize * 2) / 2;
            weights.set(key, (weights.get(key) ?? 0) + p.text.length);
        }
    }
    if (weights.size === 0) return 0;
    const sorted = [...weights.entries()].sort((a, b) => a[0] - b[0]);
    const total = sorted.reduce((sum, [, w]) => sum + w, 0);
    let acc = 0;
    for (const [size, w] of sorted) {
        acc += w;
        if (acc >= total / 2) return size;
    }
    return sorted[sorted.length - 1][0];
}

export function countWords(text: string): number {
    const matches = text.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu);
    return matches ? matches.length : 0;
}

/** Truncates a string so that its UTF-8 size stays below the cap, cutting at a whitespace boundary when possible. */
export function capText(text: string, maxBytes: number): { text: string; truncated: boolean } {
    if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, truncated: false };
    let cut = Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8');
    // Drop a possibly broken trailing multi-byte character and end at a word boundary.
    cut = cut.replace(/\u{FFFD}$/u, '');
    const boundary = cut.lastIndexOf(' ');
    if (boundary > maxBytes * 0.9) cut = cut.slice(0, boundary);
    return { text: `${cut}\n\n[truncated]`, truncated: true };
}

/* ------------------------------------------------------------------ */
/* Metadata                                                            */
/* ------------------------------------------------------------------ */

export function parsePdfDate(value: unknown): string | null {
    if (typeof value !== 'string' || !value) return null;
    const date = pdfjs.PDFDateString.toDateObject(value);
    if (date && !Number.isNaN(date.getTime())) return date.toISOString();
    const fallback = new Date(value);
    return Number.isNaN(fallback.getTime()) ? null : fallback.toISOString();
}

function cleanString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const cleaned = value.replace(/\0/g, '').trim();
    return cleaned.length > 0 ? cleaned.slice(0, 1000) : null;
}

export function buildMetadata(
    info: Record<string, unknown>,
    xmp: { get: (name: string) => unknown } | null,
): PdfMetadata {
    const xmpValue = (name: string): string | null => {
        if (!xmp) return null;
        const value = xmp.get(name);
        if (Array.isArray(value)) return cleanString(value.join(', '));
        return cleanString(value);
    };
    return {
        title: cleanString(info.Title) ?? xmpValue('dc:title'),
        author: cleanString(info.Author) ?? xmpValue('dc:creator'),
        subject: cleanString(info.Subject) ?? xmpValue('dc:description'),
        keywords: cleanString(info.Keywords) ?? xmpValue('pdf:keywords'),
        creator: cleanString(info.Creator) ?? xmpValue('xmp:creatortool'),
        producer: cleanString(info.Producer) ?? xmpValue('pdf:producer'),
        creationDate: parsePdfDate(info.CreationDate) ?? parsePdfDate(xmpValue('xmp:createdate')),
        modDate: parsePdfDate(info.ModDate) ?? parsePdfDate(xmpValue('xmp:modifydate')),
        pdfVersion: cleanString(info.PDFFormatVersion),
        encrypted: Boolean(info.EncryptFilterName),
    };
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

function isTextItem(item: unknown): item is TextItem {
    return typeof (item as TextItem).str === 'string' && Array.isArray((item as TextItem).transform);
}

/** Parses PDF bytes with pdf.js and extracts per-page paragraphs, metadata and link annotations. */
export async function extractPdf(data: Uint8Array, options: ExtractOptions): Promise<ExtractResult> {
    const task = pdfjs.getDocument({
        data,
        useSystemFonts: false,
        disableFontFace: true,
        verbosity: 0,
    });

    let doc: PDFDocumentProxy;
    try {
        doc = await task.promise;
    } catch (error) {
        const err = error as { name?: string; message?: string };
        if (err.name === 'PasswordException') {
            throw new PdfError('encrypted', 'PDF is password-protected; a user password is required to open it');
        }
        if (err.name === 'InvalidPDFException') {
            throw new PdfError('parse-error', `Invalid or corrupted PDF: ${err.message ?? 'unknown error'}`);
        }
        throw new PdfError('parse-error', `Failed to parse PDF: ${err.message ?? String(error)}`);
    }

    try {
        const pageCount = doc.numPages;
        const pagesExtracted = Math.min(pageCount, Math.max(options.maxPages, 1));

        let metadata: PdfMetadata;
        try {
            const meta = await doc.getMetadata();
            metadata = buildMetadata((meta.info ?? {}) as Record<string, unknown>, meta.metadata ?? null);
        } catch {
            metadata = buildMetadata({}, null);
        }

        const pages: PageResult[] = [];
        for (let pageNumber = 1; pageNumber <= pagesExtracted; pageNumber++) {
            const page = await doc.getPage(pageNumber);
            try {
                const content = await page.getTextContent();
                const items = content.items.filter(isTextItem);
                const paragraphs = buildParagraphs(buildLines(items));
                let links: string[] = [];
                if (options.extractLinks) {
                    const annotations = (await page.getAnnotations().catch(() => [])) as {
                        subtype?: string;
                        url?: string;
                        unsafeUrl?: string;
                    }[];
                    const fromAnnotations = annotations
                        .map((a) => a.url ?? a.unsafeUrl ?? '')
                        .filter((u) => /^https?:\/\//i.test(u) || /^mailto:/i.test(u));
                    const fromText = extractUrlsFromText(paragraphs.map((p) => p.text).join('\n'));
                    links = uniqueLinks([fromAnnotations, fromText]);
                }
                pages.push({ page: pageNumber, paragraphs, links });
            } finally {
                page.cleanup();
            }
        }

        return { pageCount, pagesExtracted, metadata, pages, bodyFontSize: estimateBodyFontSize(pages) };
    } catch (error) {
        if (error instanceof PdfError) throw error;
        const err = error as { message?: string };
        throw new PdfError('parse-error', `Failed to extract text: ${err.message ?? String(error)}`);
    } finally {
        await task.destroy().catch(() => undefined);
    }
}
