**PDF text extractor** and PDF to text API: give it public PDF URLs and it downloads each file and returns the full text, the text of every page, document metadata (title, author, dates, producer) and every link found in the document, as JSON records you can search, index or feed to an LLM.

It is built for **RAG and LLM ingestion pipelines**, research and archiving workflows: no servers to run, no PDF library to maintain, one flat price per PDF, and files that cannot be processed are reported **free of charge**.

## Features

- Extract text from PDF URLs in bulk, hundreds of files per run
- Convert PDF to plain text or Markdown with page breaks and headings
- Get PDF metadata (title, author, creation date, producer) as JSON
- Extract text from each page of a PDF separately, with character counts
- Extract all links and URLs from a PDF document
- PDF to text API for RAG, LLM and vector database pipelines
- Detect scanned PDFs without a text layer (never charged)

## What can you do with PDF Text & Metadata Extractor?

- **Feed RAG and vector databases**: extract text (plain or Markdown with page breaks) from papers, manuals and reports before chunking and embedding.
- **Research and literature review**: pull the text and metadata of hundreds of arXiv, journal or government PDFs in one run and search them offline.
- **Compliance and archive indexing**: build a full-text index of policy documents, filings and public notices, with creation and modification dates.
- **Invoice, statement and report pipelines**: extract text from supplier PDFs published on a portal and pass it to a parser or an LLM for field extraction.
- **Link discovery**: collect every URL referenced inside a set of PDFs (citations, data sources, further reading).

## How it works

For each URL the Actor downloads the file with plain HTTP (following redirects), checks the size against your limit both from the `Content-Length` header and while streaming, and verifies the `%PDF` signature so that HTML login pages, error pages and other non-PDF responses are reported instead of parsed. The PDF is then opened with Mozilla's pdf.js: text is read page by page, lines are reassembled into paragraphs, end-of-line hyphenation is repaired, metadata is read from the document info and XMP, and links are collected from link annotations and from the text itself.

Only the text layer of a PDF is extracted. Scanned documents that contain images of text return `hasText: false` and an empty text; OCR is not part of this version (see the FAQ).

## How to use it

1. Open the Actor and paste your PDF links into **PDF URLs**, one per line.
2. Pick an **Output format**: plain text, Markdown (headings guessed from font sizes, page breaks as `---`) or both.
3. Optionally adjust **Max pages per PDF** and **Max file size** to control cost and memory.
4. Click **Start**. Each PDF appears in the **Output** tab as soon as it is processed.
5. Download the dataset as JSON, CSV or Excel, or plug it into an integration (Google Drive, Airtable, Make, Zapier, LangChain, LlamaIndex).

```json
{
    "urls": ["https://arxiv.org/pdf/1706.03762", "https://bitcoin.org/bitcoin.pdf"],
    "outputFormat": "markdown",
    "perPage": true,
    "extractLinks": true,
    "maxPages": 500,
    "maxFileSizeMb": 25
}
```

## Output

One record per PDF. A successful record looks like this (text trimmed):

```json
{
    "url": "https://bitcoin.org/bitcoin.pdf",
    "finalUrl": "https://bitcoin.org/bitcoin.pdf",
    "success": true,
    "fileName": "bitcoin.pdf",
    "fileSizeBytes": 184292,
    "pageCount": 9,
    "pagesExtracted": 9,
    "wordCount": 3642,
    "hasText": true,
    "pagesWithText": 9,
    "metadata": {
        "title": null,
        "author": null,
        "subject": null,
        "keywords": null,
        "creator": "Writer",
        "producer": "OpenOffice.org 2.4",
        "creationDate": "2009-03-24T17:33:15.000Z",
        "modDate": null,
        "pdfVersion": "1.4",
        "encrypted": false
    },
    "links": ["www.bitcoin.org", "http://www.weidai.com/bmoney.txt", "http://www.hashcash.org/papers/hashcash.pdf"],
    "text": "Bitcoin: A Peer-to-Peer Electronic Cash System\n\nSatoshi Nakamoto satoshin@gmx.com www.bitcoin.org\n\nAbstract. A purely peer-to-peer version of electronic cash ...",
    "textTruncated": false,
    "pages": [
        {
            "page": 1,
            "text": "Bitcoin: A Peer-to-Peer Electronic Cash System\n\nSatoshi Nakamoto ...",
            "charCount": 3049
        },
        {
            "page": 2,
            "text": "2. Transactions\n\nWe define an electronic coin as a chain of digital signatures ...",
            "charCount": 2443
        }
    ],
    "fetchedAt": "2026-09-18T19:53:10.258Z"
}
```

URLs that could not be processed are still recorded, so nothing disappears from your list:

```json
{
    "url": "https://example.com/login",
    "success": false,
    "errorType": "not-a-pdf",
    "error": "Response is an HTML page (often a login, consent or error page), not a PDF",
    "statusCode": 200,
    "fetchedAt": "..."
}
```

## Output fields

| Field                                   | Description                                                                                                                         |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `url` / `finalUrl`                      | The URL you supplied and the URL after redirects.                                                                                   |
| `success`                               | `true` when the PDF was downloaded and parsed. Only these records (with `hasText: true`) are billed.                                |
| `fileName`, `fileSizeBytes`             | Name from `Content-Disposition` or the URL, and the downloaded size.                                                                |
| `pageCount` / `pagesExtracted`          | Real number of pages and how many were extracted (limited by **Max pages per PDF**).                                                |
| `wordCount`, `hasText`, `pagesWithText` | Words extracted; `hasText` is `false` for scanned, image-only PDFs.                                                                |
| `metadata`                              | `title`, `author`, `subject`, `keywords`, `creator`, `producer`, `creationDate`, `modDate` (ISO 8601), `pdfVersion`, `encrypted`.   |
| `text`                                  | Full plain text, paragraphs separated by blank lines. Capped at 2 MB (`textTruncated: true` when cut).                             |
| `markdown`                              | Present for `markdown` and `both` formats: headings guessed from font sizes, pages separated by `---`.                              |
| `pages[]`                               | `page`, `text` and `charCount` for every extracted page (when **Include per-page text** is on).                                     |
| `links[]`                               | Unique URLs from link annotations and from the text.                                                                                |
| `errorType`                             | For failures: `invalid-url`, `not-a-pdf`, `too-large`, `encrypted`, `http-error`, `blocked`, `network`, `timeout` or `parse-error`. |

## Use it from the API, Python, JavaScript or an AI agent

Run the Actor and get the dataset back in one HTTP call:

```bash
curl -X POST "https://api.apify.com/v2/acts/josh99smith~pdf-text-extractor/run-sync-get-dataset-items?token=<YOUR_API_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"urls": ["https://bitcoin.org/bitcoin.pdf"], "outputFormat": "markdown"}'
```

Python, with the [apify-client](https://docs.apify.com/api/client/python) package:

```python
from apify_client import ApifyClient

client = ApifyClient("<YOUR_API_TOKEN>")
run = client.actor("josh99smith/pdf-text-extractor").call(
    run_input={"urls": ["https://bitcoin.org/bitcoin.pdf"], "outputFormat": "markdown", "perPage": False}
)
for item in client.dataset(run["defaultDatasetId"]).iterate_items():
    print(item["url"], item.get("wordCount"), item.get("markdown", "")[:200])
```

JavaScript or TypeScript, with the [apify-client](https://docs.apify.com/api/client/js) package:

```javascript
import { ApifyClient } from 'apify-client';

const client = new ApifyClient({ token: '<YOUR_API_TOKEN>' });
const run = await client.actor('josh99smith/pdf-text-extractor').call({
    urls: ['https://bitcoin.org/bitcoin.pdf'],
    outputFormat: 'markdown',
    perPage: false,
});
const { items } = await client.dataset(run.defaultDatasetId).listItems();
console.log(items[0].markdown);
```

The Actor is also available as a tool through the Apify MCP server, so AI agents can call it directly, and it can be scheduled or connected to Zapier, Make, n8n and Google Sheets in the **Integrations** tab.

## Pricing: how much does it cost to extract text from a PDF?

You pay a **flat price per successfully processed PDF** (shown next to the Start button), regardless of the number of pages up to your **Max pages per PDF** limit. Invalid URLs, non-PDF responses, files above the size limit, password-protected files, download errors and scanned PDFs without a text layer cost nothing. There is no start-up fee, and the Actor stops automatically when it reaches the maximum cost you set for the run, so a long list never produces a surprise bill.

## Tips

- **Large documents**: a 500-page report and a 1-page flyer cost the same. Lower **Max pages per PDF** if you only need the first pages (for example the abstract and introduction).
- **Memory**: PDFs are parsed in memory. 512 MB is plenty at the default 25 MB limit and concurrency 5; raise memory or lower **Max concurrency** for very large files.
- **Smaller records**: turn off **Include per-page text** if you only need the full text, or set **Output format** to `text` only.
- **Markdown for LLMs**: `markdown` keeps page boundaries (`---`) and likely headings, which helps chunkers keep context together.

## FAQ

### Does it extract text from scanned PDFs?

Not in this version. Scanned PDFs contain images rather than text, so the record has `hasText: false`, `wordCount: 0` and an empty text; you still get the page count and metadata, and **such files are not charged**. Check `hasText` before sending the text on. OCR support is on the roadmap; let us know in the Issues tab if you need it.

### Why is the layout of tables and multi-column pages imperfect?

PDF stores positioned text fragments, not paragraphs. The Actor rebuilds lines and paragraphs from positions and font sizes, which works well for articles, reports and books; complex tables and multi-column layouts may come out in a different reading order.

### Can it open password-protected PDFs?

No. Files that need a password to open are reported as `errorType: "encrypted"` and are not charged. PDFs that are merely restricted (owner password, printing disabled) open normally and have `metadata.encrypted: true`.

### Which PDF URLs are supported?

Any publicly reachable `http(s)` URL that returns a PDF, including redirects and download endpoints such as `https://arxiv.org/pdf/<id>`. URLs behind logins are not supported; they typically return an HTML page and are reported as `not-a-pdf`.

### What are the limits on file size, pages and text length?

**Max file size** goes up to 200 MB (default 25 MB) and **Max pages per PDF** up to 5,000 (default 500). The `text`, `markdown` and `pages` outputs are each capped at 2 MB, with `textTruncated: true` when a cap is hit. Up to 20 PDFs are processed in parallel and each download times out after at most 300 seconds.

### Is it legal to extract text from PDFs?

The Actor downloads publicly available files exactly like a browser would, at low request rates, and stores nothing but the content of those files. You are responsible for respecting the copyright and terms of use of the documents you process.

## Related Actors by the same developer

- [Website Tech Stack Detector](https://apify.com/josh99smith/tech-stack-detector): find out what a website is built with.
- [Website Screenshot API](https://apify.com/josh99smith/website-screenshot-api): full-page screenshots and PDFs of any URL.
- [Google Autocomplete Keyword Scraper](https://apify.com/josh99smith/google-autocomplete-scraper): keyword suggestions from Google search.
- [App Store & Google Play Reviews Scraper](https://apify.com/josh99smith/app-reviews-scraper): app reviews from both stores.
- [PageSpeed Insights Core Web Vitals Audit](https://apify.com/josh99smith/pagespeed-insights-audit): Core Web Vitals via Google's API.
- [Remote Jobs Aggregator API](https://apify.com/josh99smith/remote-jobs-aggregator): remote job listings in one dataset.
- [Sitemap URL Extractor](https://apify.com/josh99smith/sitemap-url-extractor): all URLs from XML sitemaps.
- [RSS and Atom Feed to JSON](https://apify.com/josh99smith/rss-feed-to-json): RSS, Atom and JSON feeds as JSON items.

## Support and feedback

Found a PDF that extracts badly, or need OCR, table extraction or another output format? Open a ticket in the **Issues** tab of this Actor. The source is MIT licensed; PDF parsing is powered by [pdf.js](https://github.com/mozilla/pdf.js) (Apache-2.0).
