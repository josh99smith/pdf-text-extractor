import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
    categorizeNetworkError,
    deriveFileName,
    describeNonPdf,
    downloadPdf,
    looksLikePdf,
    normalizeUrl,
    PdfError,
} from '../src/download.js';

const dummyPdf = new Uint8Array(readFileSync(new URL('./fixtures/dummy.pdf', import.meta.url)));

function fakeFetch(
    body: Uint8Array | string | null,
    init: { status?: number; headers?: Record<string, string>; url?: string; chunkSize?: number } = {},
): typeof fetch {
    return (async (input: string | URL | Request) => {
        const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : (body ?? new Uint8Array());
        const chunk = init.chunkSize ?? 4096;
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                for (let i = 0; i < bytes.length; i += chunk) controller.enqueue(bytes.subarray(i, i + chunk));
                controller.close();
            },
        });
        const response = new Response(body === null ? null : stream, {
            status: init.status ?? 200,
            headers: init.headers ?? {},
        });
        Object.defineProperty(response, 'url', { value: init.url ?? String(input) });
        return response;
    }) as unknown as typeof fetch;
}

const opts = { maxBytes: 1024 * 1024, timeoutMs: 5000 };

async function expectFailure(promise: Promise<unknown>, errorType: string): Promise<PdfError> {
    try {
        await promise;
    } catch (error) {
        expect(error).toBeInstanceOf(PdfError);
        expect((error as PdfError).errorType).toBe(errorType);
        return error as PdfError;
    }
    throw new Error(`Expected failure of type ${errorType}`);
}

describe('normalizeUrl', () => {
    it('adds https:// when the scheme is missing', () => {
        expect(normalizeUrl('example.com/a.pdf')).toBe('https://example.com/a.pdf');
        expect(normalizeUrl('  https://example.com/a.pdf ')).toBe('https://example.com/a.pdf');
    });

    it('rejects non-http schemes and junk', () => {
        expect(normalizeUrl('not a url')).toBeNull();
        expect(normalizeUrl('')).toBeNull();
        expect(normalizeUrl('ftp://example.com/a.pdf')).toBeNull();
        expect(normalizeUrl('file:///etc/passwd')).toBeNull();
        expect(normalizeUrl('nohost')).toBeNull();
    });
});

describe('looksLikePdf / describeNonPdf', () => {
    it('recognises the %PDF magic bytes, even after leading junk', () => {
        expect(looksLikePdf(dummyPdf)).toBe(true);
        expect(looksLikePdf(new TextEncoder().encode('junk\n%PDF-1.7\n'))).toBe(true);
        expect(looksLikePdf(new TextEncoder().encode('<html></html>'))).toBe(false);
        expect(looksLikePdf(new Uint8Array())).toBe(false);
    });

    it('describes HTML, JSON and empty responses', () => {
        expect(describeNonPdf(new TextEncoder().encode('<!DOCTYPE html><html>'), 'text/html')).toContain('HTML page');
        expect(describeNonPdf(new TextEncoder().encode('{"error":1}'), null)).toContain('JSON');
        expect(describeNonPdf(new Uint8Array(), null)).toContain('empty');
        expect(describeNonPdf(new TextEncoder().encode('garbage'), 'text/plain')).toContain('text/plain');
    });
});

describe('deriveFileName', () => {
    it('prefers Content-Disposition, then the URL path, and always ends with .pdf', () => {
        expect(deriveFileName('https://arxiv.org/pdf/1706.03762', 'inline; filename="1706.03762v7.pdf"')).toBe(
            '1706.03762v7.pdf',
        );
        expect(deriveFileName('https://example.com/x', "attachment; filename*=UTF-8''My%20Report.pdf")).toBe(
            'My Report.pdf',
        );
        expect(deriveFileName('https://arxiv.org/pdf/1706.03762', null)).toBe('1706.03762.pdf');
        expect(deriveFileName('https://example.com/', null)).toBe('document.pdf');
        expect(deriveFileName('https://example.com/a%20b.PDF', null)).toBe('a b.PDF');
    });
});

describe('categorizeNetworkError', () => {
    it('separates timeouts from other network errors', () => {
        expect(categorizeNetworkError(new DOMException('x', 'TimeoutError')).errorType).toBe('timeout');
        expect(categorizeNetworkError(new DOMException('x', 'AbortError')).errorType).toBe('timeout');
        const dns = Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND', message: 'getaddrinfo' } });
        expect(categorizeNetworkError(dns).errorType).toBe('network');
        expect(categorizeNetworkError(dns).message).toContain('ENOTFOUND');
    });
});

describe('downloadPdf', () => {
    it('downloads a valid PDF and reports size, name and final URL', async () => {
        const result = await downloadPdf('https://example.com/a.pdf', {
            ...opts,
            fetchImpl: fakeFetch(dummyPdf, { headers: { 'content-type': 'application/pdf' }, chunkSize: 1000 }),
        });
        expect(result.fileSizeBytes).toBe(dummyPdf.length);
        expect(result.fileName).toBe('a.pdf');
        expect(result.finalUrl).toBe('https://example.com/a.pdf');
        expect(result.data.length).toBe(dummyPdf.length);
        expect(looksLikePdf(result.data)).toBe(true);
    });

    it('reports 403/429 as blocked and other 4xx/5xx as http-error', async () => {
        const blocked = await expectFailure(
            downloadPdf('https://example.com/a.pdf', { ...opts, fetchImpl: fakeFetch('denied', { status: 403 }) }),
            'blocked',
        );
        expect(blocked.statusCode).toBe(403);
        await expectFailure(
            downloadPdf('https://example.com/a.pdf', { ...opts, fetchImpl: fakeFetch('', { status: 429 }) }),
            'blocked',
        );
        const notFound = await expectFailure(
            downloadPdf('https://example.com/a.pdf', { ...opts, fetchImpl: fakeFetch('nope', { status: 404 }) }),
            'http-error',
        );
        expect(notFound.statusCode).toBe(404);
        await expectFailure(
            downloadPdf('https://example.com/a.pdf', { ...opts, fetchImpl: fakeFetch('oops', { status: 500 }) }),
            'http-error',
        );
    });

    it('rejects oversized files from Content-Length before downloading', async () => {
        const err = await expectFailure(
            downloadPdf('https://example.com/a.pdf', {
                ...opts,
                maxBytes: 1000,
                fetchImpl: fakeFetch(dummyPdf, { headers: { 'content-length': '5000000' } }),
            }),
            'too-large',
        );
        expect(err.message).toContain('Content-Length');
    });

    it('rejects oversized files while streaming when Content-Length is missing', async () => {
        const err = await expectFailure(
            downloadPdf('https://example.com/a.pdf', {
                ...opts,
                maxBytes: 5000,
                fetchImpl: fakeFetch(dummyPdf, { chunkSize: 1024 }),
            }),
            'too-large',
        );
        expect(err.message).toContain('exceeded');
    });

    it('reports HTML login pages and other non-PDF bodies as not-a-pdf', async () => {
        const err = await expectFailure(
            downloadPdf('https://example.com/a.pdf', {
                ...opts,
                fetchImpl: fakeFetch('<!DOCTYPE html><html><body>Please log in</body></html>', {
                    headers: { 'content-type': 'text/html' },
                    url: 'https://example.com/login',
                }),
            }),
            'not-a-pdf',
        );
        expect(err.message).toContain('HTML');
        expect(err.statusCode).toBe(200);
        await expectFailure(
            downloadPdf('https://example.com/a.pdf', { ...opts, fetchImpl: fakeFetch(null) }),
            'not-a-pdf',
        );
    });

    it('reports timeouts', async () => {
        const never: typeof fetch = ((_: unknown, init: { signal: AbortSignal }) =>
            new Promise((_resolve, reject) => {
                init.signal.addEventListener('abort', () => reject(init.signal.reason));
            })) as unknown as typeof fetch;
        const err = await expectFailure(
            downloadPdf('https://example.com/a.pdf', { ...opts, timeoutMs: 20, fetchImpl: never }),
            'timeout',
        );
        expect(err.message).toContain('timed out');
    });

    it('reports DNS and connection failures as network', async () => {
        const failing: typeof fetch = (async () => {
            throw Object.assign(new Error('fetch failed'), {
                cause: { code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND' },
            });
        }) as unknown as typeof fetch;
        const err = await expectFailure(
            downloadPdf('https://nope.example/a.pdf', { ...opts, fetchImpl: failing }),
            'network',
        );
        expect(err.message).toContain('ENOTFOUND');
    });
});
