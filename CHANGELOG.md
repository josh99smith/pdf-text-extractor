# Changelog

## 0.1.0 (2026-09-18)

- Initial release: downloads public PDF URLs and extracts full text, per-page text, document metadata and links with pdf.js.
- Plain text and Markdown output (headings guessed from font size, page breaks as horizontal rules), hyphenation repair and paragraph detection.
- Size cap (Content-Length and streaming), page cap, magic-byte check for non-PDF responses, password-protected PDF detection.
- Failures (`invalid-url`, `not-a-pdf`, `too-large`, `encrypted`, `http-error`, `blocked`, `network`, `timeout`, `parse-error`) are recorded in the dataset and never billed.
