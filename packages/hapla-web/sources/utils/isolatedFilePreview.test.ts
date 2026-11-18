import { describe, expect, it } from 'vitest';
import { decodeFileRoutePath, encodeFileRoutePath, decodeUtf8FilePage, fileSourceRows } from './isolatedFilePreview';

describe('bounded file source preview', () => {
    it('preserves every UTF-8 codepoint across arbitrary byte page boundaries', () => {
        const source = 'ab中文 🧪 é\n終端🙂';
        const bytes = new TextEncoder().encode(source);
        for (let size = 4; size <= 17; size++) {
            const pages = [];
            for (let offset = 0; offset < bytes.length; offset += size) pages.push(decodeUtf8FilePage(bytes.subarray(offset, offset + size + 3), size));
            expect(pages.join('')).toBe(source);
        }
    });
    it('round trips Chinese filenames and preserves legacy Latin-1 URLs', () => {
        const path = '附件/中文 & space 🧪.md';
        expect(decodeFileRoutePath(encodeFileRoutePath(path))).toBe(path);
        expect(decodeFileRoutePath(btoa('café.md'))).toBe('café.md');
    });
    it('bounds minified source rows without discarding characters or splitting surrogate pairs', () => {
        const line = 'x'.repeat(1023) + '🧪' + 'y'.repeat(5000);
        const rows = fileSourceRows(line + '\nnext');
        expect(rows.filter(row => row.line === 1).map(row => row.text).join('')).toBe(line);
        expect(rows.every(row => row.text.length <= 1024)).toBe(true);
        expect(rows[1].continued).toBe(true);
        expect(rows.at(-1)).toEqual({ line: 2, continued: false, text: 'next' });
    });
});
