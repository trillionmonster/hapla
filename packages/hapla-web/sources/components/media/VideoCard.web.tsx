import { acquireStoredCloudFile, acquireCloudFileLink, isCloudFileLink, storedCloudPath, cloudStageLabel } from '@/utils/cloudFileDelivery';
import type { CloudFileStage } from '@hapla/wire';
import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import type { MessageMedia } from './MediaGallery';
import { useGroupedArtifact } from '../ArtifactPresentation';
import { formatVideoDuration, formatVideoSize, loadVideoPreview, peekVideoPreview, rememberVideoPreview, subscribeVideoPreview, videoAspectRatio, videoPreviewKey, videoPreviewNotice, type VideoPreview } from './videoPreview';

export type VideoItem = MessageMedia & { uri: string; displayName: string };

export function VideoCard({ item }: { item: VideoItem }) {
    const grouped = useGroupedArtifact();
    const { theme } = useUnistyles();
    const ref = React.useRef<HTMLDivElement>(null);
    const [preview, setPreview] = React.useState<VideoPreview | undefined>(() => item.video ?? peekVideoPreview(item));
    const [visible, setVisible] = React.useState(false);
    const [loading, setLoading] = React.useState(true);
    const [attempt, setAttempt] = React.useState(0);
    const retries = React.useRef(0);
    const lastRequest = React.useRef<{ key: string; attempt: number } | null>(null);
    const key = videoPreviewKey(item);
    React.useEffect(() => visible ? subscribeVideoPreview(item, () => setPreview(peekVideoPreview(item))) : undefined, [item.uri, item.workspaceVideo?.sessionId, item.workspaceVideo?.path, item.previewRevision, visible]);
    React.useEffect(() => {
        if (!ref.current || typeof IntersectionObserver === 'undefined') { setVisible(true); return; }
        const observer = new IntersectionObserver(entries => {
            setVisible(entries.some(entry => entry.isIntersecting));
        }, { rootMargin: '120px' });
        observer.observe(ref.current);
        return () => observer.disconnect();
    }, []);
    React.useEffect(() => {
        if (!visible) return;
        let current = true;
        const previous = lastRequest.current;
        if (previous?.key !== key) retries.current = 0;
        const force = previous?.key === key && previous.attempt !== attempt;
        lastRequest.current = { key, attempt };
        setPreview(item.video ?? peekVideoPreview(item));
        if (item.video?.status === 'ready' && item.video.posterDataUrl) { setLoading(false); return; }
        setLoading(true);
        void loadVideoPreview(item, force).then(value => { if (current) { setPreview(value); setLoading(false); } });
        return () => { current = false; };
    }, [item.uri, item.workspaceVideo?.sessionId, item.workspaceVideo?.path, item.previewRevision, visible, attempt]);
    React.useEffect(() => {
        if (!visible || loading || preview?.posterDataUrl || !preview?.retryable || retries.current >= 2) return;
        const timer = setTimeout(() => { retries.current++; setAttempt(value => value + 1); }, Math.min(5_000, Math.max(250, preview.retryAfterMs ?? 1_000)));
        return () => clearTimeout(timer);
    }, [key, visible, loading, preview]);
    const size = preview?.sizeBytes ?? item.size;
    const expired = preview?.reason === 'source_expired';
    const ratio = preview?.aspectRatio ?? videoAspectRatio(preview?.width, preview?.height);
    const facts = [preview?.width && preview?.height ? `${preview.width} × ${preview.height}` : undefined, ratio].filter(Boolean).join(' · ');
    return (
        <div ref={ref} data-video-card aria-busy={loading && visible} style={{ boxSizing: 'border-box', width: '100%', minHeight: 112, display: 'flex', alignItems: 'center', gap: 10,
            padding: grouped ? '8px 0' : 8, color: theme.colors.text, border: grouped ? 0 : `1px solid ${theme.colors.divider}`, borderRadius: grouped ? 0 : 8, textAlign: 'left' }}>
            <div style={{ position: 'relative', width: 'clamp(88px, 26%, 132px)', height: 82, flexShrink: 0, borderRadius: 5, background: '#14181b', display: 'grid', placeItems: 'center', overflow: 'hidden' }}>
                {preview?.posterDataUrl ? <img src={preview.posterDataUrl} alt={`${item.displayName} 视频封面`} loading="lazy" decoding="async" style={{ width: '100%', height: '100%', objectFit: 'contain' }} /> : (
                    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ color: '#8b989f' }}><rect x="2" y="4" width="20" height="16" rx="4" stroke="currentColor" strokeWidth="1.25"/><path d="m10 8 6 4-6 4V8Z" fill="currentColor"/></svg>
                )}
                {preview?.durationSeconds !== undefined ? <span style={{ position: 'absolute', right: 5, bottom: 5, padding: '2px 5px', borderRadius: 4, background: '#090e13d9', color: '#fff', fontSize: theme.typography.caption.fontSize, lineHeight: `${theme.typography.caption.lineHeight}px`, fontVariantNumeric: 'tabular-nums' }}>{formatVideoDuration(preview.durationSeconds)}</span> : null}
            </div>
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2, lineHeight: `${theme.typography.small.lineHeight}px` }}>
                <span title={item.displayName} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: theme.typography.small.fontSize, fontWeight: 600 }}>{item.displayName}</span>
                <span title={!loading && !preview?.posterDataUrl ? videoPreviewNotice(preview) : undefined} style={{ color: theme.colors.textSecondary, fontSize: theme.typography.caption.fontSize, lineHeight: `${theme.typography.caption.lineHeight}px`, minHeight: theme.typography.caption.lineHeight, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', fontVariantNumeric: 'tabular-nums' }}>{facts || (loading ? '正在读取视频信息…' : videoPreviewNotice(preview))}</span>
                <span style={{ color: theme.colors.textSecondary, fontSize: theme.typography.caption.fontSize, lineHeight: `${theme.typography.caption.lineHeight}px`, minHeight: theme.typography.caption.lineHeight, fontVariantNumeric: 'tabular-nums' }} title={size !== undefined ? `原文件 ${size.toLocaleString()} 字节 · 下载保留原文件` : undefined}>{size !== undefined ? formatVideoSize(size) : loading ? '正在读取原文件大小…' : expired ? '原链接无法继续读取' : '可直接打开原视频'}</span>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, minHeight: 24, fontSize: theme.typography.caption.fontSize }}>
                    <span style={{ color: theme.colors.text }}>打开视频 <span aria-hidden="true">↗</span></span>
                    {!loading && !preview?.posterDataUrl ? <button type="button" aria-label={`刷新 ${item.displayName} 的视频信息`} onClick={event => { event.stopPropagation(); retries.current = 0; setAttempt(value => value + 1); }} style={{ border: 0, padding: '3px 0 3px 8px', background: 'transparent', color: theme.colors.textSecondary, fontSize: theme.typography.caption.fontSize, cursor: 'pointer' }}>重试预览</button> : null}
                </div>
            </div>
        </div>
    );
}

/** This component exists only inside an explicitly opened viewer. */
export function VideoPlayer({ item, onError, forceRefresh = false }: { item: VideoItem; onError: (message: string) => void; forceRefresh?: boolean }) {
    const { theme } = useUnistyles();
    const [source, setSource] = React.useState(item.workspaceVideo || storedCloudPath(item.uri) || isCloudFileLink(item.uri) ? null : item.uri);
    const [progress, setProgress] = React.useState<number | null>(null);
    const [stage, setStage] = React.useState<CloudFileStage | undefined>(undefined);
    const ref = React.useRef<HTMLVideoElement>(null);
    const attachSource = React.useRef<((video: HTMLVideoElement, onError?: (message: string) => void) => () => void) | undefined>(undefined);
    const detachSource = React.useRef<(() => void) | undefined>(undefined);
    const reportError = React.useRef(onError);
    reportError.current = onError;
    const setVideoRef = React.useCallback((element: HTMLVideoElement | null) => {
        const previous = ref.current;
        detachSource.current?.(); detachSource.current = undefined;
        if (previous && previous !== element) { previous.pause(); previous.removeAttribute('src'); previous.load(); }
        ref.current = element;
        if (element) detachSource.current = attachSource.current?.(element, message => reportError.current(message));
    }, []);
    React.useEffect(() => {
        const abort = new AbortController();
        let release: (() => void) | undefined;
        let evictionSignal: AbortSignal | undefined;
        const detach = () => {
            detachSource.current?.(); detachSource.current = undefined;
            attachSource.current = undefined;
            const element = ref.current;
            if (element) { element.pause(); element.removeAttribute('src'); element.load(); }
        };
        const evicted = () => { detach(); setSource(null); onError('视频缓存已释放，请重新打开'); };
        if (item.workspaceVideo || storedCloudPath(item.uri) || isCloudFileLink(item.uri)) {
            setSource(null);
            const prepare = item.workspaceVideo ? import('@/utils/workspaceVideoCache').then(({ acquireWorkspaceVideo }) => acquireWorkspaceVideo({
                ...item.workspaceVideo!, signal: abort.signal, onProgress: setProgress, onStage: setStage, forceRestore: forceRefresh,
            })) : storedCloudPath(item.uri) ? acquireStoredCloudFile(storedCloudPath(item.uri)!, { signal: abort.signal, onProgress: setProgress, onStage: setStage })
                : acquireCloudFileLink(item.uri, { signal: abort.signal, onProgress: setProgress, onStage: setStage, force: forceRefresh });
            void prepare.then(result => {
                if (!result) { if (!abort.signal.aborted) setSource(item.uri); return; }
                release = result.release;
                if (abort.signal.aborted) { release(); return; }
                evictionSignal = result.signal;
                evictionSignal.addEventListener('abort', evicted, { once: true });
                if (evictionSignal.aborted) { evicted(); release(); return; }
                attachSource.current = result.attach;
                if (ref.current) {
                    detachSource.current?.();
                    detachSource.current = result.attach?.(ref.current, message => reportError.current(message));
                }
                setSource(result.url);
            }).catch(error => { if (!abort.signal.aborted) onError(error instanceof Error ? error.message : '视频读取失败，请重试或检查所属工作台连接'); });
        } else setSource(item.uri);
        window.addEventListener('pagehide', detach);
        return () => {
            evictionSignal?.removeEventListener('abort', evicted);
            detach(); abort.abort(); release?.();
            window.removeEventListener('pagehide', detach);
        };
    }, [item.uri, item.workspaceVideo?.sessionId, item.workspaceVideo?.path, item.previewRevision, onError, forceRefresh]);
    if (!source) return <div role="status" style={{ color: '#d1e0e9', fontSize: theme.typography.label.fontSize }}>{stage ? cloudStageLabel(stage) : '正在打开视频'}…</div>;
    return <video
        ref={setVideoRef}
        src={source}
        poster={(item.video ?? peekVideoPreview(item))?.posterDataUrl}
        aria-label={item.displayName}
        controls playsInline preload="metadata"
        onLoadedMetadata={event => {
            const video = event.currentTarget;
            rememberVideoPreview(item, { ...peekVideoPreview(item), status: 'ready',
                width: video.videoWidth, height: video.videoHeight,
                aspectRatio: peekVideoPreview(item)?.aspectRatio ?? videoAspectRatio(video.videoWidth, video.videoHeight),
                durationSeconds: Number.isFinite(video.duration) ? video.duration : undefined,
            });
        }}
        onLoadedData={event => {
            if (peekVideoPreview(item)?.posterDataUrl) return;
            // A previously unknown external video may supply a cover after the
            // user opens it. Never create a hidden player to obtain this frame.
            const video = event.currentTarget;
            try {
                const canvas = document.createElement('canvas');
                const scale = Math.min(1, 320 / video.videoWidth, 180 / video.videoHeight);
                canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
                canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
                canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height);
                rememberVideoPreview(item, { ...peekVideoPreview(item), status: 'ready', posterStatus: 'ready', reason: undefined, retryable: undefined, retryAfterMs: undefined, posterDataUrl: canvas.toDataURL('image/jpeg', 0.65) });
            } catch { /* External hosts may disallow reading frames. */ }
        }}
        onError={() => onError(peekVideoPreview(item)?.reason === 'source_expired' ? '视频链接已过期，请更新链接或从原工作区打开视频'
            : peekVideoPreview(item)?.reason === 'source_denied' ? '视频链接已失效或访问被拒绝，请获取新的链接' : '视频无法打开，链接可能失效或格式不受支持，可重试或下载原文件')}
        style={{ width: '100%', height: '100%', objectFit: 'contain', background: '#050505' }}
    />;
}
