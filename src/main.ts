import { setTimeout as sleep } from 'node:timers/promises';

import { Actor, log } from 'apify';

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

const CHARGE_EVENT = 'pdf-processed';
const MAX_TEXT_BYTES = 2 * 1024 * 1024;

type OutputFormat = 'text' | 'markdown' | 'both';

interface Input {
    urls?: (string | { url: string })[];
    outputFormat?: OutputFormat;
    perPage?: boolean;
    maxPages?: number;
    maxFileSizeMb?: number;
    extractLinks?: boolean;
    maxConcurrency?: number;
    timeoutSecs?: number;
}

interface PageOutput {
    page: number;
    text: string;
    charCount: number;
}

interface SuccessItem {
    url: string;
    finalUrl: string;
    success: true;
    fileName: string;
    fileSizeBytes: number;
    pageCount: number;
    pagesExtracted: number;
    metadata: PdfMetadata;
    text?: string;
    markdown?: string;
    textTruncated: boolean;
    pages?: PageOutput[];
    links: string[];
    wordCount: number;
    hasText: boolean;
    pagesWithText: number;
    fetchedAt: string;
}

interface FailureItem {
    url: string;
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

const rawUrls = (input.urls ?? []).map((u) => (typeof u === 'string' ? u : (u?.url ?? '')));
if (rawUrls.length === 0) {
    await Actor.fail('Input "urls" is empty. Provide at least one PDF URL, e.g. ["https://bitcoin.org/bitcoin.pdf"].');
}

const seen = new Set<string>();
const jobs: { url: string; originalUrl: string }[] = [];
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
    jobs.push({ url: normalized, originalUrl: raw });
}
if (failures.length) await Actor.pushData(failures); // free of charge

log.info(
    `Processing ${jobs.length} PDF URL(s) with concurrency ${maxConcurrency} (max ${maxPages} pages, max ${maxFileSizeMb} MB, format "${outputFormat}").`,
);

const chargingManager = Actor.getChargingManager();
const { isPayPerEvent } = chargingManager.getPricingInfo();
let processed = 0;
let charged = 0;
let noTextLayer = 0;
let failed = 0;
let stopBecauseOfBudget = false;

async function processUrl(job: { url: string; originalUrl: string }): Promise<void> {
    const started = Date.now();
    try {
        const file = await downloadPdf(job.url, {
            maxBytes: maxFileSizeMb * 1024 * 1024,
            timeoutMs: timeoutSecs * 1000,
        });
        const result = await extractPdf(file.data, { maxPages, extractLinks });

        const pageTexts = result.pages.map((p) => renderPageText(p));
        const plainText = pageTexts.join(PAGE_BREAK_TEXT).trim();
        const wordCount = countWords(plainText);
        const pagesWithText = pageTexts.filter((t) => /\S/.test(t)).length;

        const item: SuccessItem = {
            url: job.originalUrl,
            finalUrl: file.finalUrl,
            success: true,
            fileName: file.fileName,
            fileSizeBytes: file.fileSizeBytes,
            pageCount: result.pageCount,
            pagesExtracted: result.pagesExtracted,
            metadata: result.metadata,
            textTruncated: false,
            links: extractLinks ? uniqueLinks(result.pages.map((p) => p.links)) : [],
            wordCount,
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
                const bytes = Buffer.byteLength(text, 'utf8');
                if (bytes > budget) {
                    const capped = capText(text, Math.max(budget, 0));
                    item.pages.push({ page: index + 1, text: capped.text, charCount: text.length });
                    item.textTruncated = true;
                    break;
                }
                budget -= bytes;
                item.pages.push({ page: index + 1, text, charCount: text.length });
            }
        }

        // Reorder keys so the record reads naturally in the dataset viewer.
        const ordered: SuccessItem = {
            url: item.url,
            finalUrl: item.finalUrl,
            success: true,
            fileName: item.fileName,
            fileSizeBytes: item.fileSizeBytes,
            pageCount: item.pageCount,
            pagesExtracted: item.pagesExtracted,
            wordCount: item.wordCount,
            hasText: item.hasText,
            pagesWithText: item.pagesWithText,
            metadata: item.metadata,
            links: item.links,
            ...(item.text !== undefined ? { text: item.text } : {}),
            ...(item.markdown !== undefined ? { markdown: item.markdown } : {}),
            textTruncated: item.textTruncated,
            ...(item.pages ? { pages: item.pages } : {}),
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
            charged += pushed.chargedCount ?? 0;
        } else {
            await Actor.pushData(ordered);
            noTextLayer += 1;
        }
        processed += 1;
        const scannedHint = item.hasText ? '' : ' (no text layer, likely scanned images; not charged)';
        log.info(
            `${file.finalUrl}: ${result.pageCount} page(s), ${wordCount} words, ${item.links.length} link(s), ${(file.fileSizeBytes / 1024).toFixed(0)} KB in ${Date.now() - started} ms${scannedHint}`,
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
            success: false,
            errorType: err.errorType,
            error: err.message.slice(0, 500),
            ...(err.statusCode !== undefined ? { statusCode: err.statusCode } : {}),
            fetchedAt: new Date().toISOString(),
        };
        log.warning(`${job.url}: ${item.errorType} - ${item.error}`);
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
    charged: isPayPerEvent ? charged : processed - noTextLayer,
    noTextLayer,
    failures: failed + failures.length,
    skipped: jobs.length - processed - failed,
    stoppedEarlyDueToBudget: stopBecauseOfBudget,
};
await Actor.setValue('SUMMARY', summary);
log.info(`Done. ${JSON.stringify(summary)}`);

await Actor.exit();
