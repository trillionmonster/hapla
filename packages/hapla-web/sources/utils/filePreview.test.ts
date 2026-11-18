import { describe, expect, it } from 'vitest';
import { getFileMimeType, getFilePreviewKind } from './filePreview';

describe('filePreview', () => {
    it('recognizes Web-previewable workspace media', () => {
        expect(getFilePreviewKind('/tmp/preview.PNG')).toBe('image');
        expect(getFilePreviewKind('/tmp/demo.webm')).toBe('video');
        expect(getFilePreviewKind('/tmp/audio.m4a')).toBe('audio');
        expect(getFilePreviewKind('/tmp/report.pdf')).toBe('pdf');
        expect(getFileMimeType('/tmp/vector.svg')).toBe('image/svg+xml');
    });

    it('separates source text from unsupported binary files', () => {
        expect(getFilePreviewKind('/tmp/index.tsx')).toBe('text');
        expect(getFilePreviewKind('/tmp/archive.zip')).toBe('binary');
    });
});
