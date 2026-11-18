import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearVideoPreviewCache, loadVideoPreview, peekVideoPreview, rememberVideoPreview, subscribeVideoPreview } from './videoPreview';

const mocks = vi.hoisted(() => ({ external: vi.fn() }));
vi.mock('./externalVideoPreview', () => ({ loadExternalVideoPreview: mocks.external }));
afterEach(() => { clearVideoPreviewCache(); vi.unstubAllGlobals(); mocks.external.mockReset(); });

describe('concurrent video preview and playback', () => {
    it('preserves facts obtained by the opened player when a late preview returns partial data', async () => {
        vi.stubGlobal('window', { location: { origin: 'http://localhost' } });
        vi.stubGlobal('document', {});
        let publish!: (value: unknown) => void;
        let finish!: (value: unknown) => void;
        mocks.external.mockImplementation((_uri, _signal, update) => {
            publish = update;
            return new Promise(resolve => { finish = resolve; });
        });
        const source = { uri: 'https://example.test/video.mp4' };
        const pending = loadVideoPreview(source);
        await vi.dynamicImportSettled();
        rememberVideoPreview(source, { status: 'ready', width: 640, height: 360, durationSeconds: 30, posterDataUrl: 'data:image/jpeg;base64,cG9zdGVy' });
        publish({ status: 'unavailable', sizeBytes: 100 });
        expect(peekVideoPreview(source)).toMatchObject({ status: 'ready', width: 640, sizeBytes: 100 });
        finish({ status: 'unavailable', sizeBytes: 100 });
        await expect(pending).resolves.toMatchObject({ status: 'ready', width: 640, height: 360, durationSeconds: 30, sizeBytes: 100, posterDataUrl: 'data:image/jpeg;base64,cG9zdGVy' });
    });

    it('cancels the decoder when the last visible consumer leaves', async () => {
        vi.stubGlobal('window', { location: { origin: 'http://localhost' } });
        vi.stubGlobal('document', {});
        let signal!: AbortSignal;
        mocks.external.mockImplementation((_uri, current) => {
            signal = current;
            return new Promise(resolve => current.addEventListener('abort', () => resolve({ status: 'unavailable' }), { once: true }));
        });
        const source = { uri: 'https://example.test/video.mp4' };
        const release = subscribeVideoPreview(source, () => {});
        const pending = loadVideoPreview(source);
        await vi.dynamicImportSettled();
        release();
        expect(signal.aborted).toBe(true);
        await pending;
        expect(peekVideoPreview(source)).toBeUndefined();
    });
});
