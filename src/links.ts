/**
 * Rewrites cloud share links (Google Drive, Dropbox, OneDrive/SharePoint, GitHub) to direct-download URLs.
 *
 * Share links normally open an HTML viewer page, which the downloader would correctly reject as `not-a-pdf`.
 * These rewrites are pure string transformations of well-known public URL shapes; nothing is fetched here.
 * Links that are not recognised are returned unchanged.
 */

export interface ResolvedLink {
    url: string;
    /** Which rewrite rule applied, or `null` when the URL was returned as-is. */
    provider: 'google-drive' | 'dropbox' | 'onedrive' | 'sharepoint' | 'github' | null;
}

const DRIVE_ID = /^[\w-]{10,}$/;

/** Returns a direct-download URL for known share-link formats, or the input URL unchanged. */
export function resolveShareLink(input: string): ResolvedLink {
    let url: URL;
    try {
        url = new URL(input);
    } catch {
        return { url: input, provider: null };
    }
    const host = url.hostname.toLowerCase();

    const drive = resolveGoogleDrive(url, host);
    if (drive) return { url: drive, provider: 'google-drive' };

    const dropbox = resolveDropbox(url, host);
    if (dropbox) return { url: dropbox, provider: 'dropbox' };

    const onedrive = resolveOneDrive(url, host);
    if (onedrive) return { url: onedrive, provider: 'onedrive' };

    const sharepoint = resolveSharePoint(url, host);
    if (sharepoint) return { url: sharepoint, provider: 'sharepoint' };

    const github = resolveGitHub(url, host);
    if (github) return { url: github, provider: 'github' };

    return { url: input, provider: null };
}

/**
 * Google Drive:
 *   https://drive.google.com/file/d/<id>/view?usp=sharing
 *   https://drive.google.com/open?id=<id>
 *   https://drive.google.com/uc?id=<id>
 * -> https://drive.google.com/uc?export=download&id=<id>
 */
function resolveGoogleDrive(url: URL, host: string): string | null {
    if (host !== 'drive.google.com' && host !== 'docs.google.com') return null;
    let id: string | null = null;
    const fileMatch = /^\/(?:file\/d|uc\/d)\/([^/]+)/.exec(url.pathname);
    if (fileMatch) {
        id = fileMatch[1];
    } else if (url.pathname === '/open' || url.pathname === '/uc') {
        id = url.searchParams.get('id');
    }
    if (!id || !DRIVE_ID.test(id)) return null;
    if (url.pathname === '/uc' && url.searchParams.get('export') === 'download') return null; // already direct
    return `https://drive.google.com/uc?export=download&id=${encodeURIComponent(id)}`;
}

/**
 * Dropbox:
 *   https://www.dropbox.com/s/<key>/<name>.pdf?dl=0      -> https://dl.dropboxusercontent.com/s/<key>/<name>.pdf
 *   https://www.dropbox.com/scl/fi/<id>/<name>.pdf?rlkey=...&dl=0 -> same URL with dl=1
 *   https://www.dropbox.com/sh/<key>/<token>/<name>.pdf?dl=0        -> same URL with dl=1
 * Rewrites are skipped when the link already has dl=1 or points at the content host.
 */
function resolveDropbox(url: URL, host: string): string | null {
    if (host !== 'www.dropbox.com' && host !== 'dropbox.com') return null;
    if (/^\/s\/[^/]+\/.+/.test(url.pathname)) {
        const direct = new URL(url.toString());
        direct.hostname = 'dl.dropboxusercontent.com';
        direct.searchParams.delete('dl');
        return direct.toString();
    }
    // `/scl/fi/<id>/<name>` file links and `/sh/<key>/<token>/<file>` files inside shared folders; folder views are skipped.
    if (/^\/scl\/fi\/[^/]+\/.+/.test(url.pathname) || /^\/sh\/[^/]+\/[^/]+\/.+/.test(url.pathname)) {
        if (url.searchParams.get('dl') === '1') return null;
        const direct = new URL(url.toString());
        direct.searchParams.set('dl', '1');
        return direct.toString();
    }
    return null;
}

/**
 * OneDrive (personal):
 *   https://1drv.ms/b/s!<token>?e=abc  and  https://onedrive.live.com/...?resid=...&authkey=...
 * -> https://api.onedrive.com/v1.0/shares/u!<base64url(link)>/root/content
 * This is Microsoft's documented "sharing URL" encoding for the shares API and returns the file bytes for
 * anonymous (anyone-with-the-link) shares. Already-encoded API links are left alone.
 */
function resolveOneDrive(url: URL, host: string): string | null {
    const isShort = host === '1drv.ms';
    const isLive = host === 'onedrive.live.com';
    if (!isShort && !isLive) return null;
    if (isLive && /^\/download(?:\.aspx)?$/i.test(url.pathname)) return null; // already a download link
    if (isLive && /^\/redir(?:\.aspx)?$/i.test(url.pathname)) {
        const direct = new URL(url.toString());
        direct.pathname = '/download';
        return direct.toString();
    }
    return `https://api.onedrive.com/v1.0/shares/u!${base64Url(url.toString())}/root/content`;
}

/**
 * SharePoint / OneDrive for Business:
 *   https://<tenant>.sharepoint.com/:b:/g/personal/<user>/<token>?e=abc  -> same URL with download=1
 *   https://<tenant>-my.sharepoint.com/personal/<user>/Documents/x.pdf   -> same URL with download=1
 * Only applied to file links (`:b:`, `:w:`, `:x:` etc. or paths ending in a file name); folder views are left alone.
 */
function resolveSharePoint(url: URL, host: string): string | null {
    if (!/\.sharepoint\.com$/.test(host)) return null;
    if (url.searchParams.get('download') === '1') return null;
    const isFileShare = /^\/:[a-z]:\//i.test(url.pathname) || /\.[a-z0-9]{2,5}$/i.test(url.pathname);
    if (!isFileShare) return null;
    if (/^\/:f:\//i.test(url.pathname)) return null; // folder share
    const direct = new URL(url.toString());
    direct.searchParams.set('download', '1');
    return direct.toString();
}

/**
 * GitHub:
 *   https://github.com/<owner>/<repo>/blob/<ref>/path/file.pdf -> https://github.com/<owner>/<repo>/raw/<ref>/path/file.pdf
 */
function resolveGitHub(url: URL, host: string): string | null {
    if (host !== 'github.com' && host !== 'www.github.com') return null;
    const match = /^\/([^/]+)\/([^/]+)\/blob\/(.+)$/.exec(url.pathname);
    if (!match) return null;
    const direct = new URL(url.toString());
    direct.hostname = 'github.com';
    direct.pathname = `/${match[1]}/${match[2]}/raw/${match[3]}`;
    direct.search = '';
    return direct.toString();
}

function base64Url(value: string): string {
    return Buffer.from(value, 'utf8').toString('base64').replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-');
}
