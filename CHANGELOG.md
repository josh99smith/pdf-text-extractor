# Changelog

## 0.2.0 (2026-09-18)

- `pageRange` input (`1-5, 8, 12-`) to extract only selected pages; invalid syntax fails the run with a clear message, out-of-range pages are ignored and `maxPages` still caps the total.
- `password` input (secret) for password-protected PDFs; a rejected password is reported as a free `encrypted` failure.
- Google Drive, Dropbox, OneDrive/SharePoint and GitHub share links are rewritten to direct-download URLs; the record carries `resolvedUrl`.
- `chunkSize` / `chunkOverlap` inputs add a `chunks[]` array (`index`, `page`, `text`, `charCount`) for RAG pipelines, split on paragraph boundaries, at most 2,000 chunks per PDF.
- New output fields `charCount` and `status` (`ok`, `no-text-layer`, `no-pages-in-range`); `pages[].page` reports real page numbers.
- README: examples for the new inputs, a LangChain / LlamaIndex snippet and a pricing comparison.

## 0.1.0 (2026-09-18)

- Initial release: downloads public PDF URLs and extracts full text, per-page text, document metadata and links with pdf.js.
- Plain text and Markdown output (headings guessed from font size, page breaks as horizontal rules), hyphenation repair and paragraph detection.
- Size cap (Content-Length and streaming), page cap, magic-byte check for non-PDF responses, password-protected PDF detection.
- Failures (`invalid-url`, `not-a-pdf`, `too-large`, `encrypted`, `http-error`, `blocked`, `network`, `timeout`, `parse-error`) are recorded in the dataset and never billed.
