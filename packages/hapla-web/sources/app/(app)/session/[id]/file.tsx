import * as React from 'react';
import { View, ScrollView, FlatList, ActivityIndicator, Platform, Pressable, TextInput } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useIsFocused } from '@react-navigation/native';
import { Text } from '@/components/StyledText';
import { storage, useMachine, useSession, useSessionFileCache } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { sessionResources } from '@/sync/sessionResources';
import { sessionFileDownloadInfo, sessionFileDownloadChunk, sessionBash } from '@/sync/ops';
import { useUnistyles, StyleSheet } from 'react-native-unistyles';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { FileIcon } from '@/components/FileIcon';
import { FileMediaPreview } from '@/components/FileMediaPreview';
import { resolveSessionFilePath } from '@/utils/sessionFileLinks';
import { getFileExtension, getFileMimeType, getFilePreviewKind } from '@/utils/filePreview';
import { downloadWorkspaceFile, formatFileSize, base64ToBytes } from '@/utils/workspaceFileTransfer';
import { createWorkspaceStream } from '@/utils/workspaceStream';
import { acquireWorkspaceVideo, type WorkspaceVideoLease } from '@/utils/workspaceVideoCache';
import { decodeFileRoutePath, decodeUtf8FilePage, fileSourceRows, FILE_PAGE_BYTES, isolatedFileDocument, MAX_RENDERED_DOCUMENT_BYTES } from '@/utils/isolatedFilePreview';
import { acquireCloudWorkspaceFile, readCloudFileRange, CLOUD_FILE_THRESHOLD_BYTES, cloudStageLabel, type CloudMediaAttachment } from '@/utils/cloudFileDelivery';
import type { CloudFileStage } from '@hapla/wire';
import { requestWebReleaseCheck } from '@/utils/webRelease';

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

type FilePresentation = {
    pageKey: string;
    modified: number;
    size: number;
    text: string;
    mediaUrl: string | null;
    attachVideo?: WorkspaceVideoLease['attach'];
    attachMedia?: CloudMediaAttachment;
};

type FileLoadResult =
    | { type: 'unchanged'; presentation: FilePresentation }
    | { type: 'content'; presentation: FilePresentation; release?: () => void };

type FileLoadRequest = {
    pageKey: string;
    resourceKey: string;
    availabilityAtStart: string;
    controller: AbortController;
    promise: Promise<FileLoadResult>;
    progress: { fraction: number | null; size: number | null; stage?: CloudFileStage };
    progressListeners: Set<() => void>;
};

// Expo Router can briefly overlap two instances of the same screen while its
// layouts reconcile. Text reads are safe to share and have no instance-owned
// Blob URL, so one page gets at most one stat/chunk request at a time.
const sharedTextLoads = new Map<string, Promise<FileLoadResult>>();

const isRetryablePreviewError = (problem: unknown) => problem instanceof Error
    && /not connected|disconnected|not available|not found|timed out|timeout|尚未连接|未连接|连接后|工作区信息尚未加载|找不到此会话所属/i.test(problem.message);

export default React.memo(function FileScreen() {
    const { theme } = useUnistyles();
    const isFocused = useIsFocused();
    const params = useLocalSearchParams<{ id: string; path: string; line?: string }>();
    const session = useSession(params.id);
    const machineId = session?.metadata?.machineId ?? '';
    const machine = useMachine(machineId);
    const resolved = resolveSessionFilePath(decodeFileRoutePath(params.path || ''), session?.metadata?.path);
    const filePath = resolved?.absolutePath ?? '';
    const name = filePath.split('/').pop() ?? 'file';
    const extension = getFileExtension(filePath);
    const kind = getFilePreviewKind(filePath);
    // SVG uses the browser's image decoder, which disables scripts and can
    // display a signed R2 URL without fetching the original into JavaScript.
    const isDocument = ['md', 'markdown', 'html', 'htm'].includes(extension);
    const isMedia = kind !== 'text' && kind !== 'binary';
    // The owning machine can briefly disappear while encrypted metadata is
    // refreshed. A session/path still identifies the same document, so keep
    // transport availability out of the presentation identity.
    const resourceKey = `${params.id}\u0000${filePath}`;
    const cachedFile = useSessionFileCache(params.id, filePath);
    const [page, setPage] = React.useState({ resourceKey, offset: 0 });
    const offset = page.resourceKey === resourceKey ? page.offset : 0;
    const pageKey = `${resourceKey}\u0000${offset}\u0000${kind}`;
    const [presentation, setPresentation] = React.useState<FilePresentation | null>(null);
    const [mode, setMode] = React.useState<'preview' | 'source' | 'diff'>('preview');
    const [query, setQuery] = React.useState('');
    const [diff, setDiff] = React.useState<{ resourceKey: string; text: string } | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [pendingPageKey, setPendingPageKey] = React.useState<string | null>(null);
    const [previewProgress, setPreviewProgress] = React.useState<{ pageKey: string; fraction: number | null; size: number | null; stage?: CloudFileStage } | null>(null);
    const [downloadProgress, setDownloadProgress] = React.useState<number | null>(null);
    const [revision, setRevision] = React.useState(0);
    const requestVersion = React.useRef(0);
    const presentationRef = React.useRef<FilePresentation | null>(null);
    const inFlightRef = React.useRef<FileLoadRequest | null>(null);
    const mediaReleaseRef = React.useRef<(() => void) | null>(null);
    const retryOnAvailabilityRef = React.useRef(false);
    const pageSuspendedRef = React.useRef(false);
    const availability = `${machineId}\u0000${session?.metadata?.path ?? ''}\u0000${machine?.active === true ? 'machine-online' : 'machine-offline'}\u0000${session?.active === true ? 'session-online' : 'session-offline'}\u0000${session?.metadata?.lifecycleState ?? ''}`;
    const availabilityRef = React.useRef(availability);
    availabilityRef.current = availability;
    const cachedPresentation = React.useMemo<FilePresentation | null>(() => {
        if (offset !== 0 || isMedia || !cachedFile || cachedFile.content === null || cachedFile.isBinary) return null;
        return {
            pageKey,
            modified: cachedFile.modified ?? -1,
            size: cachedFile.size ?? new TextEncoder().encode(cachedFile.content).byteLength,
            text: cachedFile.content,
            mediaUrl: null,
        };
    }, [cachedFile, isMedia, offset, pageKey]);
    const cachedPresentationRef = React.useRef(cachedPresentation);
    cachedPresentationRef.current = cachedPresentation;
    const documentFrame = React.useRef<HTMLIFrameElement | null>(null);
    const setDocumentFrame = React.useCallback((frame: HTMLIFrameElement | null) => {
        if (documentFrame.current && documentFrame.current !== frame) {
            documentFrame.current.removeAttribute('srcdoc');
        }
        documentFrame.current = frame;
    }, []);
    const list = React.useRef<FlatList<ReturnType<typeof fileSourceRows>[number]> | null>(null);
    const releasePreviewResources = React.useCallback((discardTextRead = false) => {
        const request = inFlightRef.current;
        if (request?.resourceKey === resourceKey) {
            request.controller.abort();
            request.progressListeners.clear();
            if (discardTextRead && sharedTextLoads.get(request.pageKey) === request.promise) {
                sharedTextLoads.delete(request.pageKey);
            }
            inFlightRef.current = null;
        }
        requestVersion.current++;
        retryOnAvailabilityRef.current = false;
        mediaReleaseRef.current?.();
        mediaReleaseRef.current = null;
        presentationRef.current = null;
    }, [resourceKey]);
    React.useLayoutEffect(() => { if (isFocused) return sync.retainVisibleSessions([params.id]); }, [params.id, isFocused]);

    React.useEffect(() => {
        setPage({ resourceKey, offset: 0 });
        presentationRef.current = null;
        setPresentation(null);
        setDiff(null);
        setError(null);
        setPreviewProgress(null);
        setQuery('');
        setMode(params.line ? 'source' : 'preview');
        retryOnAvailabilityRef.current = false;
    }, [resourceKey]);

    // A preview owns potentially large text and stream grants. Keep that
    // lifetime tied to the route/focus, rather than transient online flags.
    React.useEffect(() => {
        if (!isFocused || !params.id) {
            presentationRef.current = null;
            setPresentation(null);
            setDiff(null);
            setPendingPageKey(null);
            setPreviewProgress(null);
            mediaReleaseRef.current?.();
            mediaReleaseRef.current = null;
            return;
        }
        return () => releasePreviewResources();
    }, [params.id, resourceKey, isFocused, releasePreviewResources]);

    // sessionResources.release removes its registrations. Register again on a
    // user retry, without tying displayed content to every background read.
    React.useEffect(() => {
        if (!isFocused || !params.id) return;
        return sessionResources.register(params.id, () => {
            releasePreviewResources(true);
            setPresentation(null);
            setDiff(null);
            setPendingPageKey(null);
            setPreviewProgress(null);
            setError('文件预览已释放，请重试');
        });
    }, [params.id, resourceKey, isFocused, revision, releasePreviewResources]);

    React.useEffect(() => {
        if (Platform.OS !== 'web' || typeof window === 'undefined') return;
        // BFCache does not unmount React. Drop the native media URL and its
        // backing store on navigation, then read it anew when this page returns.
        const onPageHide = () => {
            pageSuspendedRef.current = true;
            releasePreviewResources(true);
            setPresentation(null);
            setDiff(null);
            setPendingPageKey(null);
            setPreviewProgress(null);
            setError(null);
        };
        const onPageShow = (event: PageTransitionEvent) => {
            if (!event.persisted || !pageSuspendedRef.current) return;
            pageSuspendedRef.current = false;
            setRevision(value => value + 1);
        };
        window.addEventListener('pagehide', onPageHide);
        window.addEventListener('pageshow', onPageShow);
        return () => {
            window.removeEventListener('pagehide', onPageHide);
            window.removeEventListener('pageshow', onPageShow);
        };
    }, [releasePreviewResources]);

    React.useEffect(() => {
        if (!isFocused || pageSuspendedRef.current) return;
        const generation = ++requestVersion.current;
        let disposed = false;
        const isCurrent = () => !disposed && generation === requestVersion.current;
        setPendingPageKey(pageKey);
        setError(null);

        let request = inFlightRef.current;
        if (!request || request.pageKey !== pageKey) {
            request?.controller.abort();
            const controller = new AbortController();
            const localPresentation = presentationRef.current;
            const previous = localPresentation?.pageKey === pageKey ? localPresentation : cachedPresentationRef.current;
            const availabilityAtStart = availabilityRef.current;
            const retained = sessionResources.capture(params.id);
            // Progress belongs to the request, so a replacement effect can
            // subscribe to an existing load and immediately recover its state.
            const progress: FileLoadRequest['progress'] = { fraction: null, size: null };
            const progressListeners = new Set<() => void>();
            const publishProgress = (fraction: number | null, size = progress.size, stage = progress.stage) => {
                if (controller.signal.aborted || !retained()) return;
                if (fraction !== null && !Number.isFinite(fraction)) return;
                progress.fraction = fraction === null ? null : Math.max(0, Math.min(1, fraction));
                progress.size = size; progress.stage = stage;
                for (const listener of progressListeners) listener();
            };
            const load = async (): Promise<FileLoadResult> => {
                if (!params.id || !filePath) throw new Error('文件路径无效');
                if (!session?.metadata?.path) throw new Error('会话工作区信息尚未加载，请重试');
                if (!resolved?.withinSessionRoot) throw new Error('文件不在当前会话工作区内');
                const info = await sessionFileDownloadInfo(params.id, filePath);
                if (!info.success) throw new Error(info.error);
                if (!retained() || (isMedia && controller.signal.aborted)) throw new DOMException('Cancelled', 'AbortError');
                if (isMedia || info.size > CLOUD_FILE_THRESHOLD_BYTES) publishProgress(null, info.size);
                if (previous?.pageKey === pageKey && previous.modified === info.modified && previous.size === info.size) {
                    return { type: 'unchanged', presentation: previous };
                }
                if (isMedia && Platform.OS === 'web') {
                    if (kind === 'video') {
                        const video = await acquireWorkspaceVideo({ sessionId: params.id, path: filePath, fileInfo: info, forceRestore: revision > 0, signal: controller.signal, onProgress: (fraction) => publishProgress(fraction), onStage: stage => publishProgress(progress.fraction, info.size, stage) });
                        if (controller.signal.aborted) { video.release(); throw new DOMException('Cancelled', 'AbortError'); }
                        const onEvicted = () => {
                            if (controller.signal.aborted || !retained()) return;
                            presentationRef.current = null;
                            setPresentation(null);
                            setError('视频预览已释放，请重新打开');
                        };
                        video.signal.addEventListener('abort', onEvicted, { once: true });
                        return { type: 'content', presentation: { pageKey, modified: info.modified, size: info.size, text: '', mediaUrl: video.url, attachVideo: video.attach }, release: () => { video.signal.removeEventListener('abort', onEvicted); video.release(); } };
                    }
                    const stream = await createWorkspaceStream({ sessionId: params.id, path: filePath, fileInfo: info, forceRestore: revision > 0, signal: controller.signal, onProgress: (fraction) => publishProgress(fraction), onStage: stage => publishProgress(progress.fraction, info.size, stage) });
                    if (controller.signal.aborted) { stream.release(); throw new DOMException('Cancelled', 'AbortError'); }
                    return { type: 'content', presentation: { pageKey, modified: info.modified, size: info.size, text: '', mediaUrl: stream.url, attachMedia: stream.attach }, release: stream.release };
                }
                if (kind === 'binary') {
                    return { type: 'content', presentation: { pageKey, modified: info.modified, size: info.size, text: '', mediaUrl: null } };
                }
                const length = Math.min(isDocument && info.size <= MAX_RENDERED_DOCUMENT_BYTES ? MAX_RENDERED_DOCUMENT_BYTES : FILE_PAGE_BYTES, Math.max(0, info.size - offset));
                if (length === 0) {
                    return { type: 'content', presentation: { pageKey, modified: info.modified, size: info.size, text: '', mediaUrl: null } };
                }
                let bytes: Uint8Array;
                if (info.size > CLOUD_FILE_THRESHOLD_BYTES) {
                    const source = await acquireCloudWorkspaceFile({ sessionId: params.id, path: filePath, fileInfo: info, forceRestore: revision > 0, signal: controller.signal,
                        onProgress: fraction => publishProgress(fraction), onStage: stage => publishProgress(progress.fraction, info.size, stage) });
                    try { bytes = await readCloudFileRange(source, offset, Math.min(length + 3, info.size - offset), controller.signal); }
                    finally { source.release(); }
                } else {
                    const chunk = await sessionFileDownloadChunk(params.id, filePath, offset, Math.min(length + 3, info.size - offset), info.modified);
                    if (!chunk.success) throw new Error(chunk.error);
                    bytes = base64ToBytes(chunk.content);
                }
                if (!retained()) throw new DOMException('Cancelled', 'AbortError');
                if (bytes.some((byte) => byte === 0)) throw new Error('此文件包含二进制内容，请下载后查看');
                return { type: 'content', presentation: { pageKey, modified: info.modified, size: info.size, text: decodeUtf8FilePage(bytes, length), mediaUrl: null } };
            };
            let promise: Promise<FileLoadResult>;
            if (isMedia) {
                promise = load();
            } else {
                promise = sharedTextLoads.get(pageKey) ?? load();
                if (!sharedTextLoads.has(pageKey)) {
                    sharedTextLoads.set(pageKey, promise);
                    void promise.then(
                        () => { if (sharedTextLoads.get(pageKey) === promise) sharedTextLoads.delete(pageKey); },
                        () => { if (sharedTextLoads.get(pageKey) === promise) sharedTextLoads.delete(pageKey); },
                    );
                }
            }
            request = { pageKey, resourceKey, availabilityAtStart, controller, promise, progress, progressListeners };
            inFlightRef.current = request;
            void promise.then(
                () => { if (inFlightRef.current === request) inFlightRef.current = null; },
                () => { if (inFlightRef.current === request) inFlightRef.current = null; },
            );
        }
        const activeRequest = request;
        const updateProgress = () => {
            if (!isCurrent() || activeRequest.controller.signal.aborted || inFlightRef.current !== activeRequest) return;
            setPreviewProgress({ pageKey, ...activeRequest.progress });
        };
        activeRequest.progressListeners.add(updateProgress);
        updateProgress();
        void activeRequest.promise.then((result) => {
            if (!isCurrent()) return;
            retryOnAvailabilityRef.current = false;
            setError(null);
            if (result.type === 'unchanged') {
                if (presentationRef.current?.pageKey !== pageKey) {
                    presentationRef.current = result.presentation;
                    setPresentation(result.presentation);
                }
                return;
            }
            mediaReleaseRef.current?.();
            mediaReleaseRef.current = result.release ?? null;
            presentationRef.current = result.presentation;
            setPresentation(result.presentation);
            setDiff(null);
            if (offset === 0 && !isMedia && kind !== 'binary') {
                const existing = storage.getState().sessionFileCache[params.id]?.[filePath];
                storage.getState().applyFileCache(
                    params.id,
                    filePath,
                    result.presentation.text,
                    existing?.diff ?? null,
                    false,
                    { size: result.presentation.size, modified: result.presentation.modified },
                );
            }
        }).catch((problem) => {
            if (!isCurrent() || (problem instanceof Error && problem.name === 'AbortError')) return;
            retryOnAvailabilityRef.current = isRetryablePreviewError(problem);
            setError(problem instanceof Error ? problem.message : '无法读取文件');
            if (retryOnAvailabilityRef.current && availabilityRef.current !== activeRequest.availabilityAtStart) {
                retryOnAvailabilityRef.current = false;
                setRevision((value) => value + 1);
            }
        }).finally(() => {
            activeRequest.progressListeners.delete(updateProgress);
            if (isCurrent()) {
                setPendingPageKey((key) => key === pageKey ? null : key);
                setPreviewProgress(null);
            }
        });
        return () => {
            disposed = true;
            activeRequest.progressListeners.delete(updateProgress);
            if (generation === requestVersion.current) requestVersion.current++;
        };
    }, [params.id, filePath, offset, isDocument, isMedia, kind, revision, isFocused, pageKey, resourceKey]);

    const previousAvailability = React.useRef(availability);
    React.useEffect(() => {
        const changed = previousAvailability.current !== availability;
        previousAvailability.current = availability;
        if (!changed || !isFocused || !retryOnAvailabilityRef.current || inFlightRef.current) return;
        retryOnAvailabilityRef.current = false;
        setRevision((value) => value + 1);
    }, [availability, isFocused]);

    const currentPresentation = presentation?.pageKey === pageKey ? presentation : cachedPresentation;
    const size = currentPresentation?.size ?? null;
    const text = currentPresentation?.text ?? '';
    const mediaUrl = currentPresentation?.mediaUrl ?? null;
    const currentDiff = diff?.resourceKey === resourceKey ? diff.text : offset === 0 ? cachedFile?.diff ?? null : null;
    const loading = currentPresentation === null && error === null;
    const mediaLoading = (isMedia || previewProgress?.stage !== undefined) && pendingPageKey === pageKey;
    const currentProgress = previewProgress?.pageKey === pageKey ? previewProgress : null;
    const previewLoadingLabel = currentProgress?.stage ? cloudStageLabel(currentProgress.stage) : currentProgress?.fraction === null || currentProgress?.fraction === undefined
        ? currentProgress?.size === null || currentProgress?.size === undefined ? '正在读取文件信息…' : '正在准备预览…'
        : currentProgress.fraction < 1 ? `正在准备预览 ${Math.floor(currentProgress.fraction * 100)}%` : '正在打开预览…';

    const canRenderDocument = isDocument && size !== null && size <= MAX_RENDERED_DOCUMENT_BYTES;
    const markup = React.useMemo(() => {
        if (!canRenderDocument || !['html', 'htm', 'svg'].includes(extension) || Platform.OS !== 'web') return { html: '', error: '' };
        try { return { html: isolatedFileDocument(text, extension === 'svg'), error: '' }; }
        catch (problem) { return { html: '', error: problem instanceof Error ? problem.message : '无法预览文档' }; }
    }, [text, extension, canRenderDocument]);
    const source = mode === 'diff' ? currentDiff ?? '' : text;
    const rows = React.useMemo(() => fileSourceRows(source), [source]);
    const visibleRows = React.useMemo(() => query ? rows.filter((row) => row.text.toLocaleLowerCase().includes(query.toLocaleLowerCase())) : rows, [rows, query]);
    const loadDiff = async () => {
        if (!resolved?.withinSessionRoot || !session?.metadata?.path) return;
        setMode('diff'); setDiff(null);
        const generation = requestVersion.current;
        try {
            const result = await sessionBash(params.id, { command: `git diff --no-ext-diff -- ${shellQuote(resolved.relativePath || '.')} | head -c 131072`, cwd: session.metadata.path });
            if (generation !== requestVersion.current) return;
            if (!result.success) throw new Error(result.error || '无法读取差异');
            setDiff({ resourceKey, text: result.stdout });
            const existing = storage.getState().sessionFileCache[params.id]?.[filePath];
            storage.getState().applyFileCache(
                params.id,
                filePath,
                currentPresentation?.text ?? existing?.content ?? null,
                result.stdout,
                existing?.isBinary ?? false,
                {
                    size: currentPresentation?.size ?? existing?.size,
                    modified: currentPresentation?.modified ?? existing?.modified,
                },
            );
        } catch (problem) { if (generation === requestVersion.current) setError(problem instanceof Error ? problem.message : '无法读取差异'); }
    };
    const download = async () => {
        if (downloadProgress !== null || !session?.metadata?.path || !resolved?.withinSessionRoot) return;
        setDownloadProgress(0);
        try {
            // A preview URL is released on route exit. The independent download
            // job owns its bytes until browser handoff and survives navigation.
            await downloadWorkspaceFile({ sessionId: params.id, path: filePath, onProgress: setDownloadProgress });
        }
        catch (problem) { if (!(problem instanceof Error && problem.name === 'AbortError')) setError(problem instanceof Error ? problem.message : '下载失败'); }
        finally { setDownloadProgress(null); }
    };
    const retryPreview = React.useCallback(() => {
        if (inFlightRef.current?.pageKey === pageKey) return;
        requestWebReleaseCheck('file-preview-retry');
        setRevision((value) => value + 1);
    }, [pageKey]);
    const failMediaPreview = React.useCallback((message: string) => {
        // A failed MediaSource cannot be reused by retrying its Blob URL. Drop
        // the lease so the existing retry action obtains a fresh video source.
        releasePreviewResources();
        setPresentation(null);
        setPendingPageKey(null);
        setPreviewProgress(null);
        setError(message);
    }, [releasePreviewResources]);
    const cancelPreview = React.useCallback(() => {
        const request = inFlightRef.current;
        if (!request || request.pageKey !== pageKey) return;
        requestVersion.current++;
        request.controller.abort();
        request.progressListeners.clear();
        inFlightRef.current = null;
        retryOnAvailabilityRef.current = false;
        setPendingPageKey(null);
        setPreviewProgress(null);
        setError('预览加载已取消，可重试');
    }, [pageKey]);
    const router = useRouter();
    const button = (label: string, action: () => void, selected = false, disabled = false) => (
        <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={action} style={[styles.button, selected && { backgroundColor: theme.colors.surfaceHigh }, disabled && { opacity: 0.4 }]}>
            <Text style={{ color: theme.colors.text }}>{label}</Text>
        </Pressable>
    );
    if (!isFocused || pageSuspendedRef.current) return null;
    return (
        <View style={styles.container}>
            <View style={styles.header}>
                <FileIcon fileName={name} size={20} />
                <View style={{ flex: 1, minWidth: 0 }}><Text numberOfLines={1} style={styles.name}>{name}</Text><Text numberOfLines={1} style={styles.meta}>{filePath}{size !== null ? ` · ${formatFileSize(size)}` : ''}</Text></View>
                {button(downloadProgress === null ? '下载' : '准备下载…', download, false, downloadProgress !== null || !session?.metadata?.path || !resolved?.withinSessionRoot)}
            </View>
            <View style={styles.toolbar}>
                {(canRenderDocument || isMedia) && button('预览', () => setMode('preview'), mode === 'preview')}
                {['html', 'htm'].includes(extension) && button('运行网页', () => router.push({ pathname: '/session/[id]/preview', params: { id: params.id, target: filePath } }))}
                {!isMedia && kind !== 'binary' && button('源码', () => setMode('source'), mode === 'source')}
                {!isMedia && kind !== 'binary' && button('差异', loadDiff, mode === 'diff')}
                {button('刷新', retryPreview, false, pendingPageKey === pageKey)}
            </View>
            {error && <View style={styles.notice}><Text style={{ color: theme.colors.textDestructive }}>{error}</Text>{button('重试', retryPreview)}</View>}
            {mediaLoading && <View style={[styles.previewLoading, loading && { flex: 1 }]}>
                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={{ color: theme.colors.text }} accessibilityLiveRegion="polite">{previewLoadingLabel}</Text>
                    {currentProgress?.fraction !== null && currentProgress?.fraction !== undefined && currentProgress.size !== null && <Text style={styles.meta}>{'文件大小'} · {formatFileSize(currentProgress.size)}</Text>}
                </View>
                {button('取消加载', cancelPreview)}
            </View>}
            {loading ? mediaLoading ? null : <ActivityIndicator style={{ flex: 1 }} color={theme.colors.textSecondary} />
                : currentPresentation === null ? null
                : kind === 'binary' ? <Text style={styles.notice}>此文件可下载，暂不支持预览。</Text>
                : isMedia ? (mediaUrl ? <FileMediaPreview key={mediaUrl} url={mediaUrl} attachVideo={currentPresentation.attachVideo} attachMedia={currentPresentation.attachMedia} onError={failMediaPreview} fileName={name} kind={kind as 'image' | 'video' | 'audio' | 'pdf'} mimeType={getFileMimeType(filePath) || 'application/octet-stream'} /> : <Text style={styles.notice}>媒体预览不可用，请下载后查看。</Text>)
                : mode === 'preview' && canRenderDocument && markup.html ? <View style={{ flex: 1 }}>{React.createElement('iframe', { ref: setDocumentFrame, title: `Preview ${name}`, srcDoc: markup.html, sandbox: '', referrerPolicy: 'no-referrer', style: { width: '100%', height: '100%', border: 0, background: '#fff' } })}</View>
                : mode === 'preview' && canRenderDocument && ['md', 'markdown'].includes(extension) ? <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }}><MarkdownView markdown={text} sessionId={params.id} /></ScrollView>
                : <>
                    {markup.error ? <Text style={styles.notice}>{markup.error}</Text> : null}
                    {size !== null && size > (isDocument ? MAX_RENDERED_DOCUMENT_BYTES : FILE_PAGE_BYTES) && <View style={styles.toolbar}>
                        {button('上一段', () => { setPage({ resourceKey, offset: Math.max(0, offset - FILE_PAGE_BYTES) }); setQuery(''); }, false, offset === 0)}
                        <Text style={styles.meta}>字节 {offset + 1}–{Math.min(size, offset + FILE_PAGE_BYTES)} / {size}</Text>
                        {button('下一段', () => { setPage({ resourceKey, offset: offset + FILE_PAGE_BYTES }); setQuery(''); }, false, offset + FILE_PAGE_BYTES >= size)}
                    </View>}
                    <TextInput accessibilityLabel="搜索当前分段" placeholder="搜索当前分段" value={query} onChangeText={setQuery} style={styles.search} />
                    {source.length === 0 ? <Text style={styles.notice}>{mode === 'diff' ? '没有差异' : '空文件'}</Text> : <FlatList ref={list} data={visibleRows} keyExtractor={(_, index) => String(index)} initialNumToRender={30} maxToRenderPerBatch={30} windowSize={5} getItemLayout={(_, index) => ({ length: 24, offset: index * 24, index })}
                        onContentSizeChange={() => { const line = Number(params.line); if (offset === 0 && Number.isInteger(line) && line > 0 && line <= visibleRows.length) list.current?.scrollToIndex({ index: line - 1, animated: false }); }}
                        renderItem={({ item, index }) => <View style={styles.row}><Text style={styles.lineNumber}>{item.continued ? '↳' : item.line}</Text><ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flex: 1 }}><Text selectable style={styles.code}>{item.text || ' '}</Text></ScrollView></View>} />}
                </>}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: { flex: 1, backgroundColor: theme.colors.surface },
    header: { flexDirection: 'row', alignItems: 'center', padding: 12, gap: 10, borderBottomWidth: 1, borderBottomColor: theme.colors.divider },
    name: { color: theme.colors.text, fontSize: theme.typography.body.fontSize, fontWeight: '600' },
    meta: { color: theme.colors.textSecondary, fontSize: theme.typography.caption.fontSize },
    toolbar: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', paddingHorizontal: 8, gap: 8 },
    button: { minHeight: 44, minWidth: 44, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 12, borderRadius: 8 },
    notice: { padding: 16, color: theme.colors.textSecondary },
    previewLoading: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16 },
    search: { margin: 8, padding: 10, minHeight: 44, borderWidth: 1, borderColor: theme.colors.divider, borderRadius: 8, color: theme.colors.text },
    row: { height: 24, flexDirection: 'row', paddingHorizontal: 12 },
    lineNumber: { width: 60, color: theme.colors.textSecondary, fontFamily: 'monospace', fontSize: theme.typography.code.fontSize },
    code: { color: theme.colors.text, fontFamily: 'monospace', fontSize: theme.typography.code.fontSize, lineHeight: theme.typography.code.lineHeight },
}));
