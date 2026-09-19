import { describe, expect, it } from 'vitest';

import { resolveShareLink } from '../src/links.js';

describe('resolveShareLink', () => {
    it('leaves ordinary and unparsable URLs unchanged', () => {
        for (const url of [
            'https://arxiv.org/pdf/1706.03762',
            'https://bitcoin.org/bitcoin.pdf',
            'https://example.com/drive.google.com/file/d/abc/view',
            'not a url',
        ]) {
            expect(resolveShareLink(url)).toEqual({ url, provider: null });
        }
    });

    describe('Google Drive', () => {
        const id = '1A2b3C4d5E6f7G8h9I0jKLMNOPqrstuv';

        it('rewrites /file/d/<id>/view and /edit links', () => {
            expect(resolveShareLink(`https://drive.google.com/file/d/${id}/view?usp=sharing`)).toEqual({
                url: `https://drive.google.com/uc?export=download&id=${id}`,
                provider: 'google-drive',
            });
            expect(resolveShareLink(`https://drive.google.com/file/d/${id}/edit`).url).toBe(
                `https://drive.google.com/uc?export=download&id=${id}`,
            );
        });

        it('rewrites /open?id= and /uc?id= links', () => {
            expect(resolveShareLink(`https://drive.google.com/open?id=${id}`).url).toBe(
                `https://drive.google.com/uc?export=download&id=${id}`,
            );
            expect(resolveShareLink(`https://drive.google.com/uc?id=${id}`).url).toBe(
                `https://drive.google.com/uc?export=download&id=${id}`,
            );
        });

        it('keeps direct download links and folder links as they are', () => {
            const direct = `https://drive.google.com/uc?export=download&id=${id}`;
            expect(resolveShareLink(direct)).toEqual({ url: direct, provider: null });
            const folder = `https://drive.google.com/drive/folders/${id}`;
            expect(resolveShareLink(folder)).toEqual({ url: folder, provider: null });
        });

        it('ignores IDs that do not look like Drive file IDs', () => {
            const bad = 'https://drive.google.com/file/d/x/view';
            expect(resolveShareLink(bad)).toEqual({ url: bad, provider: null });
        });
    });

    describe('Dropbox', () => {
        it('moves legacy /s/ links to the content host and drops dl=0', () => {
            expect(resolveShareLink('https://www.dropbox.com/s/abc123xyz/report.pdf?dl=0')).toEqual({
                url: 'https://dl.dropboxusercontent.com/s/abc123xyz/report.pdf',
                provider: 'dropbox',
            });
            expect(resolveShareLink('https://dropbox.com/s/abc123xyz/report.pdf').url).toBe(
                'https://dl.dropboxusercontent.com/s/abc123xyz/report.pdf',
            );
        });

        it('sets dl=1 on /scl/fi/ links and keeps rlkey', () => {
            expect(
                resolveShareLink('https://www.dropbox.com/scl/fi/abcd1234/report.pdf?rlkey=k3y&st=xyz&dl=0'),
            ).toEqual({
                url: 'https://www.dropbox.com/scl/fi/abcd1234/report.pdf?rlkey=k3y&st=xyz&dl=1',
                provider: 'dropbox',
            });
            expect(resolveShareLink('https://www.dropbox.com/scl/fi/abcd1234/report.pdf?rlkey=k3y').url).toBe(
                'https://www.dropbox.com/scl/fi/abcd1234/report.pdf?rlkey=k3y&dl=1',
            );
        });

        it('sets dl=1 on files inside shared folders but leaves folder links alone', () => {
            expect(resolveShareLink('https://www.dropbox.com/sh/folderkey/token/file.pdf?dl=0').url).toBe(
                'https://www.dropbox.com/sh/folderkey/token/file.pdf?dl=1',
            );
            const folder = 'https://www.dropbox.com/scl/fo/abcd1234/h?rlkey=k3y&dl=0';
            expect(resolveShareLink(folder)).toEqual({ url: folder, provider: null });
        });

        it('leaves links that already have dl=1 or use the content host unchanged', () => {
            const already = 'https://www.dropbox.com/scl/fi/abcd1234/report.pdf?rlkey=k3y&dl=1';
            expect(resolveShareLink(already)).toEqual({ url: already, provider: null });
            const content = 'https://dl.dropboxusercontent.com/s/abc123xyz/report.pdf';
            expect(resolveShareLink(content)).toEqual({ url: content, provider: null });
        });
    });

    describe('OneDrive and SharePoint', () => {
        it('encodes 1drv.ms short links for the shares API', () => {
            const result = resolveShareLink('https://1drv.ms/b/s!AbCdEf123?e=xyz');
            expect(result.provider).toBe('onedrive');
            expect(result.url).toMatch(/^https:\/\/api\.onedrive\.com\/v1\.0\/shares\/u!/);
            expect(result.url).toMatch(/\/root\/content$/);
            const encoded = /shares\/u!([^/]+)\//.exec(result.url)![1];
            expect(encoded).not.toMatch(/[+/=]/);
            const decoded = Buffer.from(encoded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
            expect(decoded).toBe('https://1drv.ms/b/s!AbCdEf123?e=xyz');
        });

        it('turns onedrive.live.com redir links into download links and keeps existing download links', () => {
            expect(resolveShareLink('https://onedrive.live.com/redir?resid=ABC!123&authkey=!XYZ').url).toBe(
                'https://onedrive.live.com/download?resid=ABC!123&authkey=!XYZ',
            );
            const already = 'https://onedrive.live.com/download?resid=ABC!123&authkey=!XYZ';
            expect(resolveShareLink(already)).toEqual({ url: already, provider: null });
        });

        it('adds download=1 to SharePoint file shares but not to folder shares', () => {
            expect(resolveShareLink('https://contoso.sharepoint.com/:b:/g/personal/user/EaBcD?e=abc')).toEqual({
                url: 'https://contoso.sharepoint.com/:b:/g/personal/user/EaBcD?e=abc&download=1',
                provider: 'sharepoint',
            });
            expect(resolveShareLink('https://contoso-my.sharepoint.com/personal/user/Documents/report.pdf').url).toBe(
                'https://contoso-my.sharepoint.com/personal/user/Documents/report.pdf?download=1',
            );
            const folder = 'https://contoso.sharepoint.com/:f:/g/personal/user/EaBcD?e=abc';
            expect(resolveShareLink(folder)).toEqual({ url: folder, provider: null });
            const already = 'https://contoso.sharepoint.com/:b:/g/personal/user/EaBcD?download=1';
            expect(resolveShareLink(already)).toEqual({ url: already, provider: null });
        });
    });

    describe('GitHub', () => {
        it('rewrites blob links to raw links', () => {
            expect(resolveShareLink('https://github.com/owner/repo/blob/main/docs/paper.pdf?raw=false')).toEqual({
                url: 'https://github.com/owner/repo/raw/main/docs/paper.pdf',
                provider: 'github',
            });
            const raw = 'https://github.com/owner/repo/raw/main/docs/paper.pdf';
            expect(resolveShareLink(raw)).toEqual({ url: raw, provider: null });
        });
    });
});
