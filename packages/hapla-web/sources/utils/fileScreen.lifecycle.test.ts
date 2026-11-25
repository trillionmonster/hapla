import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error installed renderer lacks declarations
import { act, create } from 'react-test-renderer';
import { sessionResources } from '@/sync/sessionResources';
import { onWebReleaseCheckRequested } from '@/utils/webRelease';

const fixtures = vi.hoisted(() => ({
    focused: true,
    machineId: 'test-machine',
    machineActive: undefined as boolean | undefined,
    sessionActive: undefined as boolean | undefined,
    sessionPath: '/workspace' as string | undefined,
    lifecycleState: undefined as string | undefined,
    fileCache: null as null | { content: string | null; diff: string | null; isBinary: boolean; cachedAt: number; size?: number; modified?: number },
    params: { id: 'file-screen-lifecycle', path: '' },
    info: vi.fn(), chunk: vi.fn(), bash: vi.fn(), git: vi.fn(), stream: vi.fn(), download: vi.fn(),
    applyFileCache: vi.fn(),
    retain: vi.fn(() => () => {}),
}));
vi.mock('react-native', () => ({
    View: 'View', ScrollView: 'ScrollView', FlatList: 'FlatList', ActivityIndicator: 'ActivityIndicator',
    Pressable: 'Pressable', TextInput: 'TextInput', Platform: { OS: 'web' },
}));
vi.mock('expo-router', () => ({ useLocalSearchParams: () => fixtures.params, useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@react-navigation/native', () => ({ useIsFocused: () => fixtures.focused }));
vi.mock('react-native-unistyles', async () => { const { typeScale: typography } = await import('@/constants/typeScale'); return ({
    useUnistyles: () => ({ theme: { typography,  colors: {} } }),
    StyleSheet: { create: (make: (theme: unknown) => unknown) => make({ typography,  colors: {} }) },
}); });
vi.mock('@/sync/storage', () => ({
    storage: {
        getState: () => ({
            sessionFileCache: fixtures.fileCache
                ? { [fixtures.params.id]: { '/workspace/REPORT.md': fixtures.fileCache } }
                : {},
            applyFileCache: fixtures.applyFileCache,
        }),
    },
    useSession: () => ({ active: fixtures.sessionActive, metadata: { path: fixtures.sessionPath, machineId: fixtures.machineId, lifecycleState: fixtures.lifecycleState } }),
    useMachine: () => fixtures.machineActive === undefined ? null : { active: fixtures.machineActive },
    useSessionFileCache: () => fixtures.fileCache,
}));
vi.mock('@/sync/sync', () => ({ sync: { retainVisibleSessions: fixtures.retain } }));
vi.mock('@/sync/ops', () => ({
    sessionFileDownloadInfo: fixtures.info, sessionFileDownloadChunk: fixtures.chunk, sessionBash: fixtures.bash,
}));
vi.mock('@/sync/gitWorkbench', () => ({ gitWorkbenchRpc: fixtures.git }));
vi.mock('@/components/StyledText', () => ({ Text: 'Text' }));
vi.mock('@/components/markdown/MarkdownView', () => ({ MarkdownView: 'MarkdownView' }));
vi.mock('@/components/FileIcon', () => ({ FileIcon: 'FileIcon' }));
vi.mock('@/components/FileMediaPreview', () => ({ FileMediaPreview: 'FileMediaPreview' }));
vi.mock('@/utils/workspaceStream', () => ({ createWorkspaceStream: fixtures.stream }));
vi.mock('@/utils/workspaceVideoCache', () => ({ acquireWorkspaceVideo: async (options: any) => ({ ...await fixtures.stream(options), signal: new AbortController().signal }) }));
vi.mock('@/utils/workspaceFileTransfer', () => ({
    base64ToBytes: (value: string) => Buffer.from(value, 'base64'),
    formatFileSize: (value: number) => `${value} bytes`, downloadWorkspaceFile: fixtures.download,
}));
vi.mock('@/utils/cloudFileDelivery', () => ({
    CLOUD_FILE_THRESHOLD_BYTES: 64 * 1024 * 1024,
    acquireCloudWorkspaceFile: vi.fn(), readCloudFileRange: vi.fn(), cloudStageLabel: (stage: string) => stage,
}));

import FileScreen from '@/app/(app)/session/[id]/file';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
};
const info = { success: true, size: 16, modified: 1 };
const chunk = (text: string) => ({ success: true, content: Buffer.from(text).toString('base64') });

describe('FileScreen preview request lifecycle', () => {
    let root: any;
    let tick = 0;
    const render = async () => {
        // Changing a test-only prop also rerenders the actual memoized screen on focus changes.
        const element = React.createElement(FileScreen as React.ComponentType<{ tick: number }>, { tick: tick++ });
        await act(async () => { root ? root.update(element) : root = create(element); });
    };
    const loading = () => root.root.findAllByType('ActivityIndicator').length;
    const text = () => JSON.stringify(root.toJSON());
    const retry = async () => {
        const button = root.root.findAllByType('Pressable').find((item: any) => item.props.accessibilityLabel === '重试');
        expect(button).toBeDefined();
        await act(async () => button.props.onPress());
    };
    const refresh = async () => {
        const button = root.root.findAllByType('Pressable').find((item: any) => item.props.accessibilityLabel === '刷新');
        expect(button).toBeDefined();
        await act(async () => button.props.onPress());
    };
    const cancel = async () => {
        const button = root.root.findAllByType('Pressable').find((item: any) => item.props.accessibilityLabel === '取消加载');
        expect(button).toBeDefined();
        await act(async () => button.props.onPress());
    };
    const pageEvents = () => {
        const target = new EventTarget();
        vi.stubGlobal('window', target);
        return {
            target,
            dispatch: async (type: string, persisted = false) => {
                await act(async () => target.dispatchEvent(Object.assign(new Event(type), { persisted })));
            },
        };
    };
    beforeEach(() => {
        fixtures.focused = true;
        fixtures.machineId = 'test-machine';
        fixtures.machineActive = undefined;
        fixtures.sessionActive = undefined;
        fixtures.sessionPath = '/workspace';
        fixtures.lifecycleState = undefined;
        fixtures.fileCache = null;
        fixtures.params = { id: 'file-screen-lifecycle', path: btoa('/workspace/REPORT.md') };
        fixtures.info.mockReset(); fixtures.chunk.mockReset(); fixtures.bash.mockReset(); fixtures.stream.mockReset(); fixtures.download.mockReset(); fixtures.applyFileCache.mockReset();
        fixtures.info.mockResolvedValue(info); fixtures.chunk.mockResolvedValue(chunk('CURRENT REPORT'));
        fixtures.applyFileCache.mockImplementation((_sessionId, _filePath, content, diff, isBinary, metadata) => {
            fixtures.fileCache = { content, diff, isBinary, cachedAt: Date.now(), ...metadata };
        });
    });
    afterEach(async () => {
        if (root) await act(async () => root.unmount());
        root = undefined;
        sessionResources.release(fixtures.params.id);
        vi.unstubAllGlobals();
    });

    it('ends loading when session resources release during stat, and retries without accepting the old response', async () => {
        const releaseCheck = vi.fn();
        const unsubscribe = onWebReleaseCheckRequested(releaseCheck);
        const old = deferred<typeof info>(); fixtures.info.mockReturnValueOnce(old.promise);
        await render(); expect(loading()).toBe(1);
        await act(async () => sessionResources.release(fixtures.params.id));
        expect(loading()).toBe(0); expect(text()).toContain('文件预览已释放，请重试');
        await retry();
        expect(releaseCheck).toHaveBeenCalledWith('file-preview-retry');
        unsubscribe();
        expect(root.root.findByType('MarkdownView').props.markdown).toBe('CURRENT REPORT');
        await act(async () => old.resolve(info));
        expect(fixtures.chunk).toHaveBeenCalledTimes(1);
        expect(root.root.findByType('MarkdownView').props.markdown).toBe('CURRENT REPORT');
    });

    it('ends loading during a chunk read and ignores its late completion after retry', async () => {
        const old = deferred<ReturnType<typeof chunk>>(); fixtures.chunk.mockReturnValueOnce(old.promise);
        await render(); expect(loading()).toBe(1);
        await act(async () => sessionResources.release(fixtures.params.id));
        expect(loading()).toBe(0);
        await retry();
        await act(async () => old.resolve(chunk('STALE REPORT')));
        expect(root.root.findByType('MarkdownView').props.markdown).toBe('CURRENT REPORT');
        expect(text()).not.toContain('STALE REPORT');
    });

    it('silently releases on blur, then reloads on focus without an old chunk or diff result', async () => {
        const oldChunk = deferred<ReturnType<typeof chunk>>(); fixtures.chunk.mockReturnValueOnce(oldChunk.promise);
        const oldDiff = deferred<{ text: string; nextOffset: null }>(); fixtures.git.mockReturnValueOnce(oldDiff.promise);
        await render();
        const diff = root.root.findAllByType('Pressable').find((item: any) => item.props.accessibilityLabel === '差异');
        await act(async () => { void diff.props.onPress(); });
        fixtures.focused = false; await render(); expect(root.toJSON()).toBeNull();
        await act(async () => { oldChunk.resolve(chunk('STALE REPORT')); oldDiff.resolve({ text: 'STALE DIFF', nextOffset: null }); });
        fixtures.focused = true; await render();
        expect(loading()).toBe(0); expect(text()).not.toContain('STALE');
        expect(text()).not.toContain('文件预览已释放');
        expect(fixtures.info).toHaveBeenCalledTimes(2);
    });

    it('releases a late media stream after cancellation without mounting the preview', async () => {
        fixtures.params.path = btoa('/workspace/preview.png');
        const old = deferred<{ url: string; release: () => void }>(); fixtures.stream.mockReturnValueOnce(old.promise);
        await render(); expect(loading()).toBe(1);
        await act(async () => sessionResources.release(fixtures.params.id));
        const release = vi.fn();
        await act(async () => old.resolve({ url: 'blob:stale-file-preview', release }));
        expect(loading()).toBe(0); expect(release).toHaveBeenCalledTimes(1);
        expect(root.root.findAllByType('FileMediaPreview')).toHaveLength(0);
        expect(text()).toContain('文件预览已释放，请重试');
    });

    it('shows a media read error without a misleading empty-file or source search, then retries', async () => {
        fixtures.params.path = btoa('/workspace/preview.png');
        fixtures.stream.mockRejectedValueOnce(new Error('图片读取失败'));
        await render();
        expect(text()).toContain('图片读取失败');
        expect(text()).not.toContain('空文件');
        expect(root.root.findAllByType('TextInput')).toHaveLength(0);
        expect(loading()).toBe(0);
        const release = vi.fn();
        fixtures.stream.mockResolvedValueOnce({ url: 'blob:http-image', release });
        await retry();
        expect(root.root.findByType('FileMediaPreview').props.url).toBe('blob:http-image');
        expect(text()).not.toContain('图片读取失败');
        await act(async () => root.unmount()); root = undefined;
        expect(release).toHaveBeenCalledTimes(1);
    });

    it('passes the video stream attachment to the file player and reacquires a failed source on retry', async () => {
        fixtures.params.path = btoa('/workspace/preview.mp4');
        const attach = vi.fn();
        const release = vi.fn();
        fixtures.stream.mockResolvedValueOnce({ url: 'blob:mse-preview', attach, release });
        await render();
        const player = root.root.findByType('FileMediaPreview');
        expect(player.props.url).toBe('blob:mse-preview');
        expect(player.props.attachVideo).toBe(attach);
        await act(async () => player.props.onError('视频分段读取失败，请重试'));
        expect(release).toHaveBeenCalledTimes(1);
        expect(root.root.findAllByType('FileMediaPreview')).toHaveLength(0);
        expect(text()).toContain('视频分段读取失败，请重试');

        // Stat is unchanged: retry must still get a new MediaSource rather than
        // resurrect the failed Blob URL from the previous presentation.
        const nextAttach = vi.fn();
        const nextRelease = vi.fn();
        fixtures.stream.mockResolvedValueOnce({ url: 'blob:fresh-mse-preview', attach: nextAttach, release: nextRelease });
        await retry();
        expect(fixtures.stream).toHaveBeenCalledTimes(2);
        expect(root.root.findByType('FileMediaPreview').props.attachVideo).toBe(nextAttach);
        expect(root.root.findByType('FileMediaPreview').props.url).toBe('blob:fresh-mse-preview');
        expect(text()).not.toContain('视频分段读取失败');
        fixtures.focused = false;
        await render();
        expect(nextRelease).toHaveBeenCalledTimes(1);
    });

    it('shows media preparation progress and keeps receiving it after background metadata rerenders', async () => {
        fixtures.params.path = btoa('/workspace/preview.png');
        const pending = deferred<{ url: string; release: () => void }>();
        fixtures.stream.mockReturnValueOnce(pending.promise);
        await render();
        const request = fixtures.stream.mock.calls[0][0];
        expect(text()).toContain('正在准备预览');
        await act(async () => request.onProgress(0.25));
        expect(text()).toContain('正在准备预览 25%');
        expect(text()).toContain('文件大小');
        expect(text()).toContain('16 bytes');

        fixtures.machineActive = true;
        fixtures.sessionActive = false;
        await render();
        expect(fixtures.stream).toHaveBeenCalledTimes(1);
        expect(text()).toContain('正在准备预览 25%');
        await act(async () => request.onProgress(0.75));
        expect(text()).toContain('正在准备预览 75%');
        await act(async () => request.onProgress(1));
        expect(text()).toContain('正在打开预览');
        expect(loading()).toBe(1);

        await act(async () => pending.resolve({ url: 'blob:prepared-video', release: vi.fn() }));
        expect(loading()).toBe(0);
        expect(root.root.findByType('FileMediaPreview').props.url).toBe('blob:prepared-video');
        await act(async () => request.onProgress(0.1));
        expect(text()).not.toContain('正在准备预览');
    });

    it('cancels a media load immediately, retries, and ignores old progress and late media completion', async () => {
        fixtures.params.path = btoa('/workspace/preview.png');
        const old = deferred<{ url: string; release: () => void }>();
        const next = deferred<{ url: string; release: () => void }>();
        fixtures.stream.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
        await render();
        const oldRequest = fixtures.stream.mock.calls[0][0];
        await act(async () => oldRequest.onProgress(0.4));
        await cancel();
        expect(oldRequest.signal.aborted).toBe(true);
        expect(loading()).toBe(0);
        expect(text()).toContain('预览加载已取消，可重试');
        expect(text()).not.toContain('空文件');
        await act(async () => oldRequest.onProgress(0.9));
        expect(text()).not.toContain('90%');

        await retry();
        const nextRequest = fixtures.stream.mock.calls[1][0];
        await act(async () => nextRequest.onProgress(0.2));
        const oldRelease = vi.fn();
        await act(async () => {
            oldRequest.onProgress(1);
            old.resolve({ url: 'blob:stale-preview', release: oldRelease });
        });
        expect(oldRelease).toHaveBeenCalledTimes(1);
        expect(loading()).toBe(1);
        expect(text()).toContain('正在准备预览 20%');
        expect(text()).not.toContain('已取消');
        expect(root.root.findAllByType('FileMediaPreview')).toHaveLength(0);
        await act(async () => next.resolve({ url: 'blob:current-preview', release: vi.fn() }));
        expect(root.root.findByType('FileMediaPreview').props.url).toBe('blob:current-preview');
        expect(loading()).toBe(0);
    });

    it('cancels while media stat is pending without starting the stream when stat arrives late', async () => {
        fixtures.params.path = btoa('/workspace/preview.png');
        const old = deferred<typeof info>();
        fixtures.info.mockReturnValueOnce(old.promise);
        await render();
        expect(text()).toContain('正在读取文件信息');
        await cancel();
        await act(async () => old.resolve(info));
        expect(fixtures.stream).not.toHaveBeenCalled();
        expect(loading()).toBe(0);
        expect(text()).toContain('预览加载已取消，可重试');
    });

    it('starts an independently managed download without releasing or tying it to the visible preview', async () => {
        fixtures.params.path = btoa('/workspace/preview.png');
        const release = vi.fn();
        fixtures.stream.mockResolvedValueOnce({ url: 'blob:prepared-image', release });
        await render();
        const anchor = { href: '', download: '', rel: '', style: { display: '' }, click: vi.fn(), remove: vi.fn() };
        const createElement = vi.fn(() => anchor);
        const appendChild = vi.fn();
        vi.stubGlobal('document', { createElement, body: { appendChild } });
        const button = root.root.findAllByType('Pressable').find((item: any) => item.props.accessibilityLabel === '下载');
        await act(async () => button.props.onPress());
        expect(createElement).not.toHaveBeenCalled();
        expect(fixtures.download).toHaveBeenCalledWith({ sessionId: fixtures.params.id, path: '/workspace/preview.png', onProgress: expect.any(Function) });
        expect(fixtures.stream).toHaveBeenCalledTimes(1);
        expect(release).not.toHaveBeenCalled();
        expect(root.root.findByType('FileMediaPreview').props.url).toBe('blob:prepared-image');
    });
    it('keeps the visible preview clear of errors when a managed download is intentionally cancelled', async () => {
        fixtures.params.path = btoa('/workspace/preview.png');
        fixtures.stream.mockResolvedValueOnce({ url: 'blob:prepared-image', release: vi.fn() });
        fixtures.download.mockRejectedValueOnce(new DOMException('下载已取消', 'AbortError'));
        await render();
        const button = root.root.findAllByType('Pressable').find((item: any) => item.props.accessibilityLabel === '下载');
        await act(async () => button.props.onPress());
        expect(text()).not.toContain('下载已取消'); expect(text()).not.toContain('下载失败');
        expect(root.root.findByType('FileMediaPreview').props.url).toBe('blob:prepared-image');
    });

    it('keeps the previous media mounted while refreshing and when that refresh is cancelled', async () => {
        fixtures.params.path = btoa('/workspace/preview.png');
        const initialRelease = vi.fn();
        fixtures.stream.mockResolvedValueOnce({ url: 'blob:initial-preview', release: initialRelease });
        await render();
        fixtures.info.mockResolvedValueOnce({ ...info, modified: 2 });
        const pending = deferred<{ url: string; release: () => void }>();
        fixtures.stream.mockReturnValueOnce(pending.promise);
        await refresh();
        const request = fixtures.stream.mock.calls[1][0];
        await act(async () => request.onProgress(0.5));
        expect(root.root.findByType('FileMediaPreview').props.url).toBe('blob:initial-preview');
        expect(text()).toContain('正在准备预览 50%');
        expect(initialRelease).not.toHaveBeenCalled();
        await cancel();
        expect(loading()).toBe(0);
        expect(root.root.findByType('FileMediaPreview').props.url).toBe('blob:initial-preview');
        expect(initialRelease).not.toHaveBeenCalled();
        const staleRelease = vi.fn();
        await act(async () => pending.resolve({ url: 'blob:cancelled-refresh', release: staleRelease }));
        expect(staleRelease).toHaveBeenCalledTimes(1);
        expect(root.root.findByType('FileMediaPreview').props.url).toBe('blob:initial-preview');
    });

    it('rejects old media progress after a route change and after losing focus', async () => {
        fixtures.params.path = btoa('/workspace/first.png');
        const first = deferred<{ url: string; release: () => void }>();
        const second = deferred<{ url: string; release: () => void }>();
        fixtures.stream.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
        await render();
        const firstRequest = fixtures.stream.mock.calls[0][0];
        await act(async () => firstRequest.onProgress(0.6));
        fixtures.params = { ...fixtures.params, path: btoa('/workspace/second.png') };
        await render();
        const secondRequest = fixtures.stream.mock.calls[1][0];
        expect(firstRequest.signal.aborted).toBe(true);
        await act(async () => {
            secondRequest.onProgress(0.3);
            firstRequest.onProgress(0.9);
        });
        expect(text()).toContain('正在准备预览 30%');
        expect(text()).not.toContain('90%');
        fixtures.focused = false;
        await render();
        expect(secondRequest.signal.aborted).toBe(true);
        await act(async () => secondRequest.onProgress(0.8));
        expect(root.toJSON()).toBeNull();
        const firstRelease = vi.fn();
        const secondRelease = vi.fn();
        await act(async () => {
            first.resolve({ url: 'blob:first', release: firstRelease });
            second.resolve({ url: 'blob:second', release: secondRelease });
        });
        expect(firstRelease).toHaveBeenCalledTimes(1);
        expect(secondRelease).toHaveBeenCalledTimes(1);
        fixtures.stream.mockResolvedValueOnce({ url: 'blob:refocused', release: vi.fn() });
        fixtures.focused = true;
        await render();
        expect(root.root.findByType('FileMediaPreview').props.url).toBe('blob:refocused');
        expect(text()).not.toContain('80%');
    });

    it('releases a displayed preview on BFCache pagehide and loads a fresh URL when the page returns', async () => {
        const events = pageEvents();
        fixtures.params.path = btoa('/workspace/preview.png');
        const initialRelease = vi.fn();
        const restored = deferred<{ url: string; release: () => void }>();
        fixtures.stream.mockResolvedValueOnce({ url: 'blob:before-navigation', release: initialRelease }).mockReturnValueOnce(restored.promise);
        await render();
        await events.dispatch('pagehide', true);
        expect(initialRelease).toHaveBeenCalledTimes(1);
        expect(root.toJSON()).toBeNull();

        await events.dispatch('pageshow', true);
        expect(fixtures.info).toHaveBeenCalledTimes(2);
        expect(fixtures.stream).toHaveBeenCalledTimes(2);
        expect(root.root.findAllByType('FileMediaPreview')).toHaveLength(0);
        expect(loading()).toBe(1);
        const restoredRelease = vi.fn();
        await act(async () => restored.resolve({ url: 'blob:after-navigation', release: restoredRelease }));
        expect(root.root.findByType('FileMediaPreview').props.url).toBe('blob:after-navigation');
        expect(text()).not.toContain('blob:before-navigation');
        await events.dispatch('pageshow', true);
        expect(fixtures.stream).toHaveBeenCalledTimes(2);
        expect(restoredRelease).not.toHaveBeenCalled();
    });

    it('ignores a pre-navigation request and its late progress after returning from BFCache', async () => {
        const events = pageEvents();
        fixtures.params.path = btoa('/workspace/preview.mp4');
        const before = deferred<{ url: string; release: () => void }>();
        const after = deferred<{ url: string; release: () => void }>();
        fixtures.stream.mockReturnValueOnce(before.promise).mockReturnValueOnce(after.promise);
        await render();
        const oldRequest = fixtures.stream.mock.calls[0][0];
        await act(async () => oldRequest.onProgress(0.5));
        await events.dispatch('pagehide', true);
        expect(oldRequest.signal.aborted).toBe(true);
        await events.dispatch('pageshow', true);
        const newRequest = fixtures.stream.mock.calls[1][0];
        const oldRelease = vi.fn();
        await act(async () => {
            newRequest.onProgress(0.2);
            oldRequest.onProgress(0.9);
            before.resolve({ url: 'blob:stale-navigation', release: oldRelease });
        });
        expect(oldRelease).toHaveBeenCalledTimes(1);
        expect(loading()).toBe(1);
        expect(text()).toContain('正在准备预览 20%');
        expect(text()).not.toContain('90%');
        expect(root.root.findAllByType('FileMediaPreview')).toHaveLength(0);
        await act(async () => after.resolve({ url: 'blob:restored-video', release: vi.fn() }));
        expect(root.root.findByType('FileMediaPreview').props.url).toBe('blob:restored-video');
    });

    it('does not release media for background visibility changes or an initial pageshow', async () => {
        const events = pageEvents();
        fixtures.params.path = btoa('/workspace/preview.mp4');
        const release = vi.fn();
        fixtures.stream.mockResolvedValueOnce({ url: 'blob:background-video', release });
        await render();
        await events.dispatch('visibilitychange');
        await events.dispatch('pageshow');
        expect(release).not.toHaveBeenCalled();
        expect(fixtures.stream).toHaveBeenCalledTimes(1);
        expect(root.root.findByType('FileMediaPreview').props.url).toBe('blob:background-video');
    });

    it('also releases on ordinary pagehide and removes page lifecycle handlers on unmount', async () => {
        const events = pageEvents();
        const remove = vi.spyOn(events.target, 'removeEventListener');
        fixtures.params.path = btoa('/workspace/preview.png');
        const release = vi.fn();
        fixtures.stream.mockResolvedValueOnce({ url: 'blob:leaving-preview', release });
        await render();
        await events.dispatch('pagehide', false);
        expect(release).toHaveBeenCalledTimes(1);
        expect(root.toJSON()).toBeNull();
        await act(async () => root.unmount()); root = undefined;
        expect(remove).toHaveBeenCalledWith('pagehide', expect.any(Function));
        expect(remove).toHaveBeenCalledWith('pageshow', expect.any(Function));
        await events.dispatch('pageshow', true);
        expect(fixtures.stream).toHaveBeenCalledTimes(1);
        expect(release).toHaveBeenCalledTimes(1);
        remove.mockRestore();
    });

    it('does not label a failed text read as an empty file', async () => {
        fixtures.chunk.mockResolvedValueOnce({ success: false, error: 'File unavailable' });
        await render();
        expect(text()).toContain('File unavailable');
        expect(text()).not.toContain('空文件');
        expect(root.root.findAllByType('TextInput')).toHaveLength(0);
    });

    it('retries when the owning machine becomes available after cold metadata loading', async () => {
        fixtures.info.mockRejectedValueOnce(new Error('所属机器尚未连接'));
        await render();
        expect(loading()).toBe(0); expect(text()).toContain('所属机器尚未连接');
        fixtures.machineActive = true;
        await render();
        expect(fixtures.info).toHaveBeenCalledTimes(2);
        expect(root.root.findByType('MarkdownView').props.markdown).toBe('CURRENT REPORT');
        expect(text()).not.toContain('所属机器尚未连接');
    });

    it('keeps rendered content mounted without another read when runtime presence flaps', async () => {
        fixtures.machineActive = true;
        fixtures.sessionActive = true;
        fixtures.lifecycleState = 'active';
        await render();
        expect(root.root.findByType('MarkdownView').props.markdown).toBe('CURRENT REPORT');
        expect(fixtures.info).toHaveBeenCalledTimes(1);
        expect(fixtures.chunk).toHaveBeenCalledTimes(1);

        fixtures.machineActive = false;
        fixtures.sessionActive = false;
        fixtures.lifecycleState = 'sleeping';
        await render();
        fixtures.machineActive = true;
        fixtures.sessionActive = true;
        fixtures.lifecycleState = 'active';
        await render();

        expect(loading()).toBe(0);
        expect(root.root.findByType('MarkdownView').props.markdown).toBe('CURRENT REPORT');
        expect(fixtures.info).toHaveBeenCalledTimes(1);
        expect(fixtures.chunk).toHaveBeenCalledTimes(1);
    });

    it('keeps the current document visible and deduplicates refreshes while stat is pending', async () => {
        await render();
        const pending = deferred<typeof info>();
        fixtures.info.mockReturnValueOnce(pending.promise);

        await refresh();
        expect(loading()).toBe(0);
        expect(root.root.findByType('MarkdownView').props.markdown).toBe('CURRENT REPORT');
        expect(fixtures.info).toHaveBeenCalledTimes(2);

        await refresh();
        expect(fixtures.info).toHaveBeenCalledTimes(2);
        await act(async () => pending.resolve(info));

        expect(loading()).toBe(0);
        expect(root.root.findByType('MarkdownView').props.markdown).toBe('CURRENT REPORT');
        expect(fixtures.chunk).toHaveBeenCalledTimes(1);
    });

    it('keeps cached text visible while the same file remounts and revalidates in the background', async () => {
        await render();
        expect(root.root.findByType('MarkdownView').props.markdown).toBe('CURRENT REPORT');
        expect(fixtures.applyFileCache).toHaveBeenCalledWith(
            fixtures.params.id,
            '/workspace/REPORT.md',
            'CURRENT REPORT',
            null,
            false,
            { size: info.size, modified: info.modified },
        );

        await act(async () => root.unmount());
        root = undefined;
        const pending = deferred<typeof info>();
        fixtures.info.mockReturnValueOnce(pending.promise);
        await render();

        expect(loading()).toBe(0);
        expect(root.root.findByType('MarkdownView').props.markdown).toBe('CURRENT REPORT');
        expect(fixtures.info).toHaveBeenCalledTimes(2);
        await act(async () => pending.resolve(info));
        expect(fixtures.chunk).toHaveBeenCalledTimes(1);
        expect(root.root.findByType('MarkdownView').props.markdown).toBe('CURRENT REPORT');
    });

    it('does not replace a rendered absolute file when owning-machine metadata briefly disappears', async () => {
        await render();
        expect(root.root.findByType('MarkdownView').props.markdown).toBe('CURRENT REPORT');

        fixtures.machineId = '';
        fixtures.sessionPath = undefined;
        await render();
        fixtures.machineId = 'test-machine';
        fixtures.sessionPath = '/workspace';
        await render();

        expect(loading()).toBe(0);
        expect(root.root.findByType('MarkdownView').props.markdown).toBe('CURRENT REPORT');
        expect(fixtures.info).toHaveBeenCalledTimes(1);
        expect(fixtures.chunk).toHaveBeenCalledTimes(1);
    });

    it('shares one stat and chunk while two router instances overlap', async () => {
        const pending = deferred<typeof info>();
        fixtures.info.mockReturnValueOnce(pending.promise);
        await render();
        let overlapping: any;
        await act(async () => {
            overlapping = create(React.createElement(FileScreen));
        });

        expect(fixtures.info).toHaveBeenCalledTimes(1);
        await act(async () => pending.resolve(info));
        expect(fixtures.chunk).toHaveBeenCalledTimes(1);
        expect(root.root.findByType('MarkdownView').props.markdown).toBe('CURRENT REPORT');
        expect(overlapping.root.findByType('MarkdownView').props.markdown).toBe('CURRENT REPORT');
        await act(async () => overlapping.unmount());
    });
});
