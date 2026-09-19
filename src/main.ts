import { setTimeout as sleep } from 'node:timers/promises';

import { Actor, log } from 'apify';

import { type Chunk, chunkPages, DEFAULT_MAX_CHUNKS, MIN_CHUNK_SIZE, normalizeChunkOptions } from './chunk.js';
import { downloadPdf, type FailureType, normalizeUrl, PdfError } from './download.js';
import {
    capText,
    countWords,
    extractPdf,
    PAGE_BREAK_MARKDOWN,
    PAGE_BREAK_TEXT,
    type PdfMetadata,
    renderPageMarkdown,
    renderPageText,
    uniqueLinks,
} from './extract.js';
import { resolveShareLink } from './links.js';
import { formatPageRange, type PageRange, PageRangeError, parsePageRange } from './pages.js';

const CHARGE_EVENT = 'pdf-processed';
const MAX_TEXT_BYTES = 2 * 1024 * 1024;

type OutputFormat = 'text' | 'markdown' | 'both';

interface Input {
    urls?: (string | { url: string })[];
    outputFormat?: OutputFormat;
    perPage?: boolean;
    maxPages?: number;
    pageRange?: string;
    chunkSize?: number;
    chunkOverlap?: number;
    maxFileSizeMb?: number;
    extractLinks?: boolean;
    password?: string;
    maxConcurrency?: number;
    timeoutSecs?: number;
}

type ResultStatus = 'ok' | 'no-text-layer' | 'no-pages-in-range';

interface PageOutput {
    page: number;
    text: string;
    charCount: number;
}

interface SuccessItem {
    url: string;
    resolvedUrl?: string;
    finalUrl: string;
    success: true;
    status: ResultStatus;
    fileName: string;
    fileSizeBytes: number;
    pageCount: number;
    pagesExtracted: number;
    metadata: PdfMetadata;
    text?: string;
    markdown?: string;
    textTruncated: boolean;
    pages?: PageOutput[];
    chunks?: Chunk[];
    links: string[];
    wordCount: number;
    charCount: number;
    hasText: boolean;
    pagesWithText: number;
    fetchedAt: string;
}

interface FailureItem {
    url: string;
    resolvedUrl?: string;
    success: false;
    errorType: FailureType;
    error: string;
    statusCode?: number;
    fetchedAt: string;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
    const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
    return Math.min(Math.max(n, min), max);
}

await Actor.init();

let aborting = false;
Actor.on('aborting', async () => {
    aborting = true;
    await sleep(1000);
    await Actor.exit();
});

const input = (await Actor.getInput<Input>()) ?? {};
const outputFormat: OutputFormat = ['text', 'markdown', 'both'].includes(input.outputFormat ?? '')
    ? (input.outputFormat as OutputFormat)
    : 'text';
const perPage = input.perPage ?? true;
const maxPages = clampInt(input.maxPages, 500, 1, 5000);
const maxFileSizeMb = clampInt(input.maxFileSizeMb, 25, 1, 200);
const extractLinks = input.extractLinks ?? true;
const maxConcurrency = clampInt(input.maxConcurrency, 5, 1, 20);
const timeoutSecs = clampInt(input.timeoutSecs, 60, 5, 300);
const password = typeof input.password === 'string' && input.password.length > 0 ? input.password : undefined;

let pageRanges: PageRange[] | null = null;
try {
    pageRanges = parsePageRange(typeof input.pageRange === 'string' ? input.pageRange : '');
} catch (error) {
    if (error instanceof PageRangeError) await Actor.fail(`Input "pageRange": ${error.message}`);
    throw error;
}

const chunkSizeInput = clampInt(input.chunkSize, 0, 0, 100_000);
const chunking = chunkSizeInput > 0;
const chunkOptions = normalizeChunkOptions({
    chunkSize: chunkSizeInput,
    chunkOverlap: clampInt(input.chunkOverlap, 200, 0, 100_000),
    maxChunks: DEFAULT_MAX_CHUNKS,
});
if (chunking && chunkSizeInput < MIN_CHUNK_SIZE) {
    log.warning(`Input "chunkSize" ${chunkSizeInput} is too small; using ${MIN_CHUNK_SIZE}.`);
}
if (chunking && (input.chunkOverlap ?? 200) > chunkOptions.chunkOverlap) {
    log.warning(`Input "chunkOverlap" must be at most half of "chunkSize"; using ${chunkOptions.chunkOverlap}.`);
}

const rawUrls = (input.urls ?? []).map((u) => (typeof u === 'string' ? u : (u?.url ?? '')));
if (rawUrls.length === 0) {
    await Actor.fail('Input "urls" is empty. Provide at least one PDF URL, e.g. ["https://bitcoin.org/bitcoin.pdf"].');
}

interface Job {
    /** Normalised URL; used for de-duplication. */
    url: string;
    /** URL exactly as supplied; echoed in the output. */
    originalUrl: string;
    /** Direct-download URL after share-link rewriting; equals `url` when no rewrite applied. */
    fetchUrl: string;
}

const seen = new Set<string>();
const jobs: Job[] = [];
const failures: FailureItem[] = [];
for (const raw of rawUrls) {
    const normalized = normalizeUrl(raw);
    if (!normalized) {
        failures.push({
            url: raw,
            success: false,
            errorType: 'invalid-url',
            error: 'Not a valid http(s) URL',
            fetchedAt: new Date().toISOString(),
        });
        continue;
    }
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    const resolved = resolveShareLink(normalized);
    if (resolved.provider) log.debug(`Rewrote ${resolved.provider} share link ${normalized} -> ${resolved.url}`);
    jobs.push({ url: normalized, originalUrl: raw, fetchUrl: resolved.url });
}
if (failures.length) await Actor.pushData(failures); // free of charge

const chunkSummary = chunking
    ? `, chunks of ${chunkOptions.chunkSize} chars with ${chunkOptions.chunkOverlap} overlap`
    : '';
log.info(
    `Processing ${jobs.length} PDF URL(s) with concurrency ${maxConcurrency} (pages ${formatPageRange(pageRanges)}, max ${maxPages} pages, max ${maxFileSizeMb} MB, format "${outputFormat}"${chunkSummary}${password ? ', password set' : ''}).`,
);

const chargingManager = Actor.getChargingManager();
const { isPayPerEvent } = chargingManager.getPricingInfo();
let processed = 0;
let charged = 0;
let noTextLayer = 0;
let noPagesInRange = 0;
let failed = 0;
let stopBecauseOfBudget = false;

async function processUrl(job: Job): Promise<void> {
    const started = Date.now();
    const resolvedUrl = job.fetchUrl !== job.url ? { resolvedUrl: job.fetchUrl } : {};
    try {
        const file = await downloadPdf(job.fetchUrl, {
            maxBytes: maxFileSizeMb * 1024 * 1024,
            timeoutMs: timeoutSecs * 1000,
        });
        const result = await extractPdf(file.data, { maxPages, extractLinks, pageRanges, password });

        const pageTexts = result.pages.map((p) => renderPageText(p));
        const plainText = pageTexts.join(PAGE_BREAK_TEXT).trim();
        const wordCount = countWords(plainText);
        const pagesWithText = pageTexts.filter((t) => /\S/.test(t)).length;
        let status: ResultStatus = 'ok';
        if (result.pagesExtracted === 0 && result.pageCount > 0) status = 'no-pages-in-range';
        else if (pagesWithText === 0) status = 'no-text-layer';

        const item: SuccessItem = {
            url: job.originalUrl,
            ...resolvedUrl,
            finalUrl: file.finalUrl,
            success: true,
            status,
            fileName: file.fileName,
            fileSizeBytes: file.fileSizeBytes,
            pageCount: result.pageCount,
            pagesExtracted: result.pagesExtracted,
            metadata: result.metadata,
            textTruncated: false,
            links: extractLinks ? uniqueLinks(result.pages.map((p) => p.links)) : [],
            wordCount,
            charCount: plainText.length,
            hasText: pagesWithText > 0,
            pagesWithText,
            fetchedAt: new Date().toISOString(),
        };

        if (outputFormat === 'text' || outputFormat === 'both') {
            const capped = capText(plainText, MAX_TEXT_BYTES);
            item.text = capped.text;
            item.textTruncated ||= capped.truncated;
        }
        if (outputFormat === 'markdown' || outputFormat === 'both') {
            const markdown = result.pages
                .map((p) => renderPageMarkdown(p, result.bodyFontSize))
                .join(PAGE_BREAK_MARKDOWN)
                .trim();
            const capped = capText(markdown, MAX_TEXT_BYTES);
            item.markdown = capped.text;
            item.textTruncated ||= capped.truncated;
        }
        if (perPage) {
            // Keep the per-page array within the same overall byte budget as the full text.
            let budget = MAX_TEXT_BYTES;
            item.pages = [];
            for (const [index, text] of pageTexts.entries()) {
                const pageNumber = result.pages[index].page;
                const bytes = Buffer.byteLength(text, 'utf8');
                if (bytes > budget) {
                    const capped = capText(text, Math.max(budget, 0));
                    item.pages.push({ page: pageNumber, text: capped.text, charCount: text.length });
                    item.textTruncated = true;
                    break;
                }
                budget -= bytes;
                item.pages.push({ page: pageNumber, text, charCount: text.length });
            }
        }
        if (chunking) {
            item.chunks = chunkPages(
                result.pages.map((p, index) => ({ page: p.page, text: pageTexts[index] })),
                chunkOptions,
            );
        }

        // Reorder keys so the record reads naturally in the dataset viewer.
        const ordered: SuccessItem = {
            url: item.url,
            ...resolvedUrl,
            finalUrl: item.finalUrl,
            success: true,
            status: item.status,
            fileName: item.fileName,
            fileSizeBytes: item.fileSizeBytes,
            pageCount: item.pageCount,
            pagesExtracted: item.pagesExtracted,
            wordCount: item.wordCount,
            charCount: item.charCount,
            hasText: item.hasText,
            pagesWithText: item.pagesWithText,
            metadata: item.metadata,
            links: item.links,
            ...(item.text !== undefined ? { text: item.text } : {}),
            ...(item.markdown !== undefined ? { markdown: item.markdown } : {}),
            textTruncated: item.textTruncated,
            ...(item.pages ? { pages: item.pages } : {}),
            ...(item.chunks ? { chunks: item.chunks } : {}),
            fetchedAt: item.fetchedAt,
        };

        // Silent-failure guard: a PDF with zero pages is not a deliverable result.
        if (result.pageCount === 0) {
            throw new PdfError('parse-error', 'PDF contains no pages');
        }

        // Silent-failure guard: a PDF without a text layer (scanned images) delivers no text, so it is not billed.
        let eventChargeLimitReached = false;
        if (item.hasText) {
            const pushed = await Actor.pushData(ordered, CHARGE_EVENT);
            eventChargeLimitReached = pushed.eventChargeLimitReached;
            charged += 1;
        } else {
            await Actor.pushData(ordered);
            if (status === 'no-pages-in-range') noPagesInRange += 1;
            else noTextLayer += 1;
        }
        processed += 1;
        let hint = '';
        if (status === 'no-pages-in-range') hint = ' (page range selects no pages of this document; not charged)';
        else if (status === 'no-text-layer') hint = ' (no text layer, likely scanned images; not charged)';
        const chunkHint = item.chunks ? `, ${item.chunks.length} chunk(s)` : '';
        log.info(
            `${file.finalUrl}: ${result.pagesExtracted}/${result.pageCount} page(s), ${wordCount} words, ${item.links.length} link(s)${chunkHint}, ${(file.fileSizeBytes / 1024).toFixed(0)} KB in ${Date.now() - started} ms${hint}`,
        );
        if (eventChargeLimitReached) {
            stopBecauseOfBudget = true;
            log.warning(
                'Maximum charge limit for this run reached; stopping early. Raise the run cost limit to process more PDFs.',
            );
        }
    } catch (error) {
        failed += 1;
        const err =
            error instanceof PdfError ? error : new PdfError('parse-error', (error as Error).message ?? String(error));
        const item: FailureItem = {
            url: job.originalUrl,
            ...resolvedUrl,
            success: false,
            errorType: err.errorType,
            error: err.message.slice(0, 500),
            ...(err.statusCode !== undefined ? { statusCode: err.statusCode } : {}),
            fetchedAt: new Date().toISOString(),
        };
        log.warning(`${job.fetchUrl}: ${item.errorType} - ${item.error}`);
        await Actor.pushData(item); // free of charge: users only pay for extracted PDFs
    }
}

// Simple worker pool: `maxConcurrency` workers pull from a shared queue and stop on budget exhaustion or abort.
let cursor = 0;
async function worker(): Promise<void> {
    while (cursor < jobs.length && !stopBecauseOfBudget && !aborting) {
        const job = jobs[cursor++];
        await processUrl(job);
    }
}
await Promise.all(Array.from({ length: Math.min(maxConcurrency, jobs.length) }, async () => worker()));

const summary = {
    requested: rawUrls.length,
    processed,
    charged: isPayPerEvent ? charged : processed - noTextLayer - noPagesInRange,
    noTextLayer,
    noPagesInRange,
    failures: failed + failures.length,
    skipped: jobs.length - processed - failed,
    stoppedEarlyDueToBudget: stopBecauseOfBudget,
};
await Actor.setValue('SUMMARY', summary);
log.info(`Done. ${JSON.stringify(summary)}`);

await Actor.exit();
