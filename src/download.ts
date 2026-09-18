export type FailureType =
    | 'invalid-url'
    | 'not-a-pdf'
    | 'too-large'
    | 'encrypted'
    | 'http-error'
    | 'blocked'
    | 'network'
    | 'timeout'
    | 'parse-error';

export class PdfError extends Error {
    constructor(
        public readonly errorType: FailureType,
        message: string,
        public readonly statusCode?: number,
    ) {
        super(message);
        this.name = 'PdfError';
    }
}

export interface DownloadedPdf {
    data: Uint8Array;
    finalUrl: string;
    fileName: string;
    fileSizeBytes: number;
    statusCode: number;
    contentType: string | null;
}

export interface DownloadOptions {
    maxBytes: number;
    timeoutMs: number;
    userAgent?: string;
    /** Injectable for tests. */
    fetchImpl?: typeof fetch;
}

// An honest, descriptive user agent. Some hosts (e.g. w3.org) reject spoofed browser UAs that lack client-hint headers.
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (compatible; ApifyPdfTextExtractor/0.1; +https://apify.com/store)';

/** Accepts `example.com/file.pdf` and `https://example.com/file.pdf`; rejects anything that is not an http(s) URL with a host. */
export function normalizeUrl(raw: string): string | null {
    let value = raw.trim();
    if (!value) return null;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `https://${value}`;
    try {
        const parsed = new URL(value);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
        if (!parsed.hostname || (!parsed.hostname.includes('.') && parsed.hostname !== 'localhost')) return null;
        return parsed.toString();
    } catch {
        return null;
    }
}

/** A real PDF starts with `%PDF-`; the spec allows up to 1024 bytes of junk before it. */
export function looksLikePdf(bytes: Uint8Array): boolean {
    const head = Buffer.from(bytes.subarray(0, 1024)).toString('latin1');
    return head.includes('%PDF-');
}

export function describeNonPdf(bytes: Uint8Array, contentType: string | null): string {
    const head = Buffer.from(bytes.subarray(0, 512)).toString('latin1').trim().toLowerCase();
    if (
        head.startsWith('<!doctype html') ||
        head.startsWith('<html') ||
        head.includes('<head') ||
        head.includes('<body')
    ) {
        return 'Response is an HTML page (often a login, consent or error page), not a PDF';
    }
    if (head.startsWith('{') || head.startsWith('[')) return 'Response is JSON, not a PDF';
    if (bytes.length === 0) return 'Response body is empty';
    return `Response is not a PDF (missing %PDF header${contentType ? `, content-type "${contentType}"` : ''})`;
}

/** File name from Content-Disposition when present, else from the URL path; always ends with `.pdf`. */
export function deriveFileName(finalUrl: string, contentDisposition: string | null): string {
    let name = '';
    if (contentDisposition) {
        const star = /filename\*\s*=\s*(?:utf-8|UTF-8)?''([^;]+)/.exec(contentDisposition);
        const plain = /filename\s*=\s*"?([^";]+)"?/.exec(contentDisposition);
        if (star?.[1]) {
            name = safeDecode(star[1]);
        } else if (plain?.[1]) {
            name = plain[1];
        }
    }
    if (!name) {
        try {
            const segments = new URL(finalUrl).pathname.split('/').filter(Boolean);
            name = safeDecode(segments[segments.length - 1] ?? '');
        } catch {
            name = '';
        }
    }
    name = name.trim().replace(/[\\/:*?"<>|]/g, '_');
    if (!name) name = 'document';
    if (!/\.pdf$/i.test(name)) name = `${name}.pdf`;
    return name;
}

function safeDecode(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

export function categorizeNetworkError(error: unknown): { errorType: FailureType; message: string } {
    const err = error as { name?: string; message?: string; cause?: { code?: string; message?: string } };
    const code = err.cause?.code ?? '';
    const message = [err.message, err.cause?.message, code].filter(Boolean).join(' - ');
    const lower = message.toLowerCase();
    if (
        err.name === 'AbortError' ||
        err.name === 'TimeoutError' ||
        lower.includes('timed out') ||
        lower.includes('timeout') ||
        code === 'UND_ERR_CONNECT_TIMEOUT'
    ) {
        return { errorType: 'timeout', message: `Download timed out (${message})` };
    }
    return { errorType: 'network', message: message || 'Network error' };
}

/**
 * Downloads a URL into memory, enforcing the size cap both via Content-Length (before reading) and
 * via a streaming byte counter (while reading), and verifies the PDF magic bytes.
 */
export async function downloadPdf(url: string, options: DownloadOptions): Promise<DownloadedPdf> {
    const fetchImpl = options.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(
        () => controller.abort(new DOMException(`Timed out after ${options.timeoutMs} ms`, 'TimeoutError')),
        options.timeoutMs,
    );

    try {
        let response: Response;
        try {
            response = await fetchImpl(url, {
                signal: controller.signal,
                redirect: 'follow',
                headers: {
                    'user-agent': options.userAgent ?? DEFAULT_USER_AGENT,
                    accept: 'application/pdf,*/*;q=0.8',
                    'accept-language': 'en-US,en;q=0.9',
                },
            });
        } catch (error) {
            const { errorType, message } = categorizeNetworkError(error);
            throw new PdfError(errorType, message);
        }

        const { status } = response;
        const finalUrl = response.url || url;
        const contentType = response.headers.get('content-type');
        const statusText = `HTTP ${status}${response.statusText ? ` ${response.statusText}` : ''}`;
        if (status === 401 || status === 403 || status === 429 || status === 503) {
            await response.body?.cancel().catch(() => undefined);
            throw new PdfError('blocked', `${statusText} (access denied or rate limited)`, status);
        }
        if (status >= 400) {
            await response.body?.cancel().catch(() => undefined);
            throw new PdfError('http-error', statusText, status);
        }

        const declared = Number(response.headers.get('content-length'));
        if (Number.isFinite(declared) && declared > options.maxBytes) {
            await response.body?.cancel().catch(() => undefined);
            throw new PdfError(
                'too-large',
                `File is ${formatMb(declared)} MB (Content-Length), above the ${formatMb(options.maxBytes)} MB limit`,
                status,
            );
        }

        const chunks: Buffer[] = [];
        let received = 0;
        if (response.body) {
            const reader = response.body.getReader();
            try {
                for (;;) {
                    let step: ReadableStreamReadResult<Uint8Array>;
                    try {
                        step = await reader.read();
                    } catch (error) {
                        const { errorType, message } = categorizeNetworkError(error);
                        throw new PdfError(errorType, message, status);
                    }
                    if (step.done) break;
                    received += step.value.byteLength;
                    if (received > options.maxBytes) {
                        await reader.cancel().catch(() => undefined);
                        throw new PdfError(
                            'too-large',
                            `Download exceeded the ${formatMb(options.maxBytes)} MB limit (stopped after ${formatMb(received)} MB)`,
                            status,
                        );
                    }
                    chunks.push(Buffer.from(step.value.buffer, step.value.byteOffset, step.value.byteLength));
                }
            } finally {
                reader.releaseLock();
            }
        }
        const data = new Uint8Array(Buffer.concat(chunks));
        if (!looksLikePdf(data)) {
            throw new PdfError('not-a-pdf', describeNonPdf(data, contentType), status);
        }

        return {
            data,
            finalUrl,
            fileName: deriveFileName(finalUrl, response.headers.get('content-disposition')),
            fileSizeBytes: data.byteLength,
            statusCode: status,
            contentType,
        };
    } finally {
        clearTimeout(timer);
    }
}

function formatMb(bytes: number): string {
    const mb = bytes / (1024 * 1024);
    return mb >= 10 ? mb.toFixed(0) : mb.toFixed(1);
}
