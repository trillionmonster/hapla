import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { DownloadJob } from '@/utils/downloadManager';
const fixture = vi.hoisted(() => ({ jobs: [] as DownloadJob[] }));
vi.mock('@/utils/downloadManager', () => ({ getDownloadJobs: () => fixture.jobs, subscribeDownloads: () => () => {}, cancelDownload: vi.fn(), retryDownload: vi.fn(), dismissDownload: vi.fn() }));
vi.mock('react-native-unistyles', async () => { const { typeScale: typography } = await import('@/constants/typeScale'); return ({ useUnistyles: () => ({ theme: { typography,  colors: { text: '#eee', textSecondary: '#aaa', surfaceHigh: '#333', divider: '#555' } } }) }); });
import { DownloadManager } from './DownloadManager.web';
describe('download preparation feedback', () => {
    it('does not present estimated cloud preparation fractions as downloaded bytes', () => {
        for (const progress of [.775, 1]) {
            fixture.jobs = [{ id: 'one', name: 'video.mp4', state: 'running', progress, stage: '正在等待 Cloudflare 文件就绪', startedAt: Date.now() - 40_000 }];
            const html = renderToStaticMarkup(React.createElement(DownloadManager));
            expect(html).toContain('已等待 40 秒');
            expect(html.replace(/<[^>]*>/g, '')).not.toMatch(/78%|100%/);
            expect(html).not.toContain('aria-valuenow');
            expect(html).toContain('准备完成后自动开始下载');
        }
    });
    it('provides a real clickable attachment link when automatic download is blocked', () => {
        const url = 'https://test.r2.cloudflarestorage.com/video?response-content-disposition=attachment&response-content-type=application%2Foctet-stream';
        fixture.jobs = [{ id: 'one', name: 'video.mp4', state: 'handed-off', progress: 1, browserUrl: url }];
        const html = renderToStaticMarkup(React.createElement(DownloadManager));
        expect(html).toContain('未开始？点击这里下载');
        expect(html).toContain('download="video.mp4"');
        expect(html).toContain('target="_self"');
        expect(html).toContain('response-content-disposition=attachment');
    });
});
