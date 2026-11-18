import * as React from 'react';
// @ts-expect-error installed renderer lacks declarations
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudLinkLease } from '@/utils/cloudFileDelivery';

const calls = vi.hoisted(() => ({ stored: vi.fn(), cloud: vi.fn() }));
vi.mock('@/utils/cloudFileDelivery', () => ({
    acquireStoredCloudFile: calls.stored,
    acquireCloudFileLink: calls.cloud,
    storedCloudPath: (uri: string) => uri.startsWith('/files/') ? uri : null,
    isCloudFileLink: (uri: string) => uri.startsWith('https://bucket.r2.cloudflarestorage.com/'),
    cloudStageLabel: () => '正在确认文件状态',
}));
vi.mock('react-native-unistyles', async () => {
    const { typeScale: typography } = await import('@/constants/typeScale');
    return { useUnistyles: () => ({ theme: { typography } }) };
});
import { CloudMediaSource } from './CloudMediaSource.web';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
    return { promise, resolve, reject };
}
const source = (name = 'image.png'): CloudLinkLease => ({
    url: `https://bucket.r2.cloudflarestorage.com/${name}`,
    downloadUrl: `https://bucket.r2.cloudflarestorage.com/${name}?download=1`,
    release: vi.fn(), signal: new AbortController().signal, attach: () => () => {},
});

describe('visible image preparation lifecycle', () => {
    let root: any;
    const report = vi.fn();
    const render = async (uri = '/files/image.png', onError = report) => {
        const element = React.createElement(CloudMediaSource, { uri, onError,
            children: (url: string) => React.createElement('img', { src: url }),
        });
        await act(async () => {
            if (root) root.update(element);
            else root = create(element, { createNodeMock: () => ({}) });
        });
    };
    beforeEach(() => { vi.clearAllMocks(); });
    afterEach(async () => {
        if (root) await act(async () => root.unmount());
        root = undefined;
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it('keeps a pending visible image preparation alive across streamed parent renders', async () => {
        const pending = deferred<CloudLinkLease>();
        calls.stored.mockReturnValue(pending.promise);
        await render();
        const request = calls.stored.mock.calls[0][1];
        for (let token = 0; token < 20; token++) await render();
        expect(calls.stored).toHaveBeenCalledTimes(1);
        expect(request.signal.aborted).toBe(false);
        const ready = source();
        await act(async () => pending.resolve(ready));
        expect(root.root.findByType('img').props.src).toBe(ready.url);
        await act(async () => root.unmount()); root = undefined;
        expect(ready.release).toHaveBeenCalledTimes(1);
        expect(request.signal.aborted).toBe(true);
    });

    it('keeps a small image visible while the original waits and replaces it when ready', async () => {
        const pending = deferred<CloudLinkLease>();
        calls.stored.mockReturnValue(pending.promise);
        await act(async () => {
            root = create(React.createElement(CloudMediaSource, { uri: '/files/image.png', onError: report,
                waitingPreview: React.createElement('img', { src: '/files/image.png?preview=image' }),
                children: (url: string) => React.createElement('img', { src: url }),
            }), { createNodeMock: () => ({}) });
        });
        expect(root.root.findByType('img').props.src).toBe('/files/image.png?preview=image');
        expect(root.root.findByProps({ role: 'status' })).toBeTruthy();
        const ready = source();
        await act(async () => pending.resolve(ready));
        expect(root.root.findAllByType('img')).toHaveLength(1);
        expect(root.root.findByType('img').props.src).toBe(ready.url);
        expect(root.root.findAllByProps({ role: 'status' })).toHaveLength(0);
    });

    it('does not start offscreen media until visible, then starts exactly once', async () => {
        let visible!: (entries: { isIntersecting: boolean }[]) => void;
        const disconnect = vi.fn();
        vi.stubGlobal('IntersectionObserver', class {
            constructor(callback: typeof visible) { visible = callback; }
            observe = vi.fn();
            disconnect = disconnect;
        });
        calls.stored.mockReturnValue(new Promise(() => {}));
        await render();
        expect(calls.stored).not.toHaveBeenCalled();
        await act(async () => visible([{ isIntersecting: false }]));
        expect(calls.stored).not.toHaveBeenCalled();
        await act(async () => visible([{ isIntersecting: true }]));
        await act(async () => visible([{ isIntersecting: true }]));
        expect(calls.stored).toHaveBeenCalledTimes(1);
        expect(disconnect).toHaveBeenCalled();
    });

    it('releases a late response after a different image is selected without rendering stale media', async () => {
        const first = deferred<CloudLinkLease>();
        const second = deferred<CloudLinkLease>();
        calls.stored.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
        await render('/files/first.png');
        const originalRequest = calls.stored.mock.calls[0][1];
        await render('/files/second.png');
        expect(originalRequest.signal.aborted).toBe(true);
        const stale = source('first.png');
        await act(async () => first.resolve(stale));
        expect(stale.release).toHaveBeenCalledTimes(1);
        expect(root.root.findAllByType('img')).toHaveLength(0);
        const ready = source('second.png');
        await act(async () => second.resolve(ready));
        expect(root.root.findByType('img').props.src).toBe(ready.url);
    });


    it('shows elapsed waiting without invented progress and retries only on an explicit click', async () => {
        vi.useFakeTimers();
        const first = deferred<CloudLinkLease>();
        const second = deferred<CloudLinkLease>();
        calls.stored.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
        await render();
        const originalRequest = calls.stored.mock.calls[0][1];
        await act(async () => vi.advanceTimersByTime(14_000));
        expect(root.root.findAllByType('button')).toHaveLength(0);
        await act(async () => vi.advanceTimersByTime(1_000));
        expect(JSON.stringify(root.toJSON())).toContain('15');
        expect(root.root.findByType('progress').props.value).toBeUndefined();
        expect(calls.stored).toHaveBeenCalledTimes(1);
        // A slow, healthy NAS upload may run for an hour. Merely waiting must
        // never abort it or create a repeated restart loop.
        await act(async () => vi.advanceTimersByTime(120_000));
        expect(calls.stored).toHaveBeenCalledTimes(1);
        expect(originalRequest.signal.aborted).toBe(false);
        const event = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
        await act(async () => root.root.findByProps({ 'aria-label': '重新确认媒体文件' }).props.onClick(event));
        expect(event.stopPropagation).toHaveBeenCalledOnce();
        expect(originalRequest.signal.aborted).toBe(true);
        expect(calls.stored).toHaveBeenCalledTimes(2);
        expect(calls.stored.mock.calls[1][0]).toBe('/files/image.png');
        expect(calls.stored.mock.calls[1][1]).toMatchObject({ force: true, forceRestore: true });
        expect(root.root.findAllByType('button')).toHaveLength(0);
        const ready = source();
        await act(async () => second.resolve(ready));
        expect(root.root.findByType('img').props.src).toBe(ready.url);
        expect(vi.getTimerCount()).toBe(0);
        const stale = source('stale.png');
        await act(async () => first.resolve(stale));
        expect(stale.release).toHaveBeenCalledOnce();
        expect(root.root.findByType('img').props.src).toBe(ready.url);
    });

    it('preserves an expired signed URL as the restore input and stops its wait timer on close', async () => {
        vi.useFakeTimers();
        calls.cloud.mockReturnValue(new Promise(() => {}));
        const uri = 'https://bucket.r2.cloudflarestorage.com/image.png?X-Amz-Signature=old&X-Amz-Expires=1';
        await render(uri);
        await act(async () => vi.advanceTimersByTime(15_000));
        await act(async () => root.root.findByType('button').props.onClick({ preventDefault() {}, stopPropagation() {} }));
        expect(calls.cloud).toHaveBeenCalledTimes(2);
        expect(calls.cloud.mock.calls[1][0]).toBe(uri);
        expect(calls.cloud.mock.calls[1][1].force).toBe(true);
        const request = calls.cloud.mock.calls[1][1];
        await act(async () => root.unmount()); root = undefined;
        expect(request.signal.aborted).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('reports a preparation failure for retry instead of silently retaining the waiting card', async () => {
        const pending = deferred<CloudLinkLease>();
        calls.stored.mockReturnValue(pending.promise);
        await render();
        await act(async () => pending.reject(new Error('文件服务暂时不可用，请重试')));
        expect(report).toHaveBeenCalledWith('文件服务暂时不可用，请重试');
    });
});
