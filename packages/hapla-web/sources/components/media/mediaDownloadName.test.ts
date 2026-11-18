import { describe, expect, it } from 'vitest';
import { getMediaDownloadName } from './mediaDisplayName';

describe('saved media filenames', () => {
    it('retains extensions for human captions and strips unsafe filename characters', () => {
        expect(getMediaDownloadName('https://bucket.test/original.mp4?signature=private', '猫咪足球梦')).toBe('猫咪足球梦.mp4');
        expect(getMediaDownloadName('https://bucket.test/original.mp4', '猫咪 审看版.mp4')).toBe('猫咪 审看版.mp4');
        expect(getMediaDownloadName('https://bucket.test/file.zip', '文件/版本\n2')).toBe('文件_版本_2.zip');
        const long = getMediaDownloadName('https://bucket.test/original.mp4', '猫'.repeat(300));
        expect(new TextEncoder().encode(long).length).toBeLessThanOrEqual(480);
        expect(long.endsWith('.mp4')).toBe(true);
    });
});
