import type * as PdfJsModule from 'pdfjs-dist/legacy/build/pdf.mjs';

/**
 * Loads the pdf.js legacy (Node) build.
 *
 * At import time pdf.js tries to load the optional `@napi-rs/canvas` package to polyfill `DOMMatrix`/`Path2D`
 * and prints console warnings when it is missing. Those polyfills are only needed for *rendering* pages to
 * images; text and metadata extraction work without them, and the Docker image deliberately omits optional
 * native dependencies. The import is wrapped so that only these expected warnings are muted.
 */
type PdfJs = typeof PdfJsModule;

const MUTED = [/@napi-rs\/canvas/, /Cannot polyfill/, /Cannot access the `require` function/];

const originalWarn = console.warn;
console.warn = (...args: unknown[]) => {
    const text = String(args[0] ?? '');
    if (MUTED.some((pattern) => pattern.test(text))) return;
    originalWarn(...args);
};

let loaded: PdfJs;
try {
    loaded = await import('pdfjs-dist/legacy/build/pdf.mjs');
} finally {
    console.warn = originalWarn;
}

export const pdfjs: PdfJs = loaded;
