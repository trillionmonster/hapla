import type { Theme } from '@/theme';
import { CloudMediaSource } from './CloudMediaSource.web';
import { storedCloudPath, storedImagePreviewUrl, downloadStoredFile, isCloudFileLink, downloadCloudFileLink, openCloudFileLink, type CloudMediaAttachment } from '@/utils/cloudFileDelivery';
import * as React from 'react';
import { createPortal } from 'react-dom';
import { Pressable, useWindowDimensions, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useUnistyles } from 'react-native-unistyles';
import type { MessageMedia } from './MediaGallery';
import { getMediaKind, type MediaKind } from './mediaKind';
import { mediaFallbackLink } from './mediaFallbackLink';
import { VideoCard, VideoPlayer } from './VideoCard.web';
import { VideoDownloadAction } from './VideoDownloadAction.web';
import { getMediaDisplayName } from './mediaDisplayName';
import { browserDownloadAttributes } from '@/utils/browserDownload';
import { useGroupedArtifact } from '../ArtifactPresentation';

type ResolvedMedia = MessageMedia & {
    uri: string;
    kind: Exclude<MediaKind, 'unknown'>;
    displayName: string;
};

function mediaDisplayName(item: MessageMedia, uri: string, index: number): string {
    return getMediaDisplayName(uri, item.name, `媒体 ${index + 1}`);
}

export function MediaGallery(props: { media: MessageMedia[] }) {
    const grouped = useGroupedArtifact();
    const { theme } = useUnistyles();
    const mediaStyles = getMediaStyles(theme);
    const { width } = useWindowDimensions();
    const compact = width <= 700;
    const [activeIndex, setActiveIndex] = React.useState<number | null>(null);
    const [retainedIndex, setRetainedIndex] = React.useState<number | null>(null);
    const [toolbarError, setToolbarError] = React.useState<string | null>(null);
    const [previewSuspended, setPreviewSuspended] = React.useState(false);
    const [downloadPreparing, setDownloadPreparing] = React.useState(false);
    const downloadRunning = React.useRef(false);
    const viewerRef = React.useRef<HTMLDivElement | null>(null);
    const { resolved, links } = React.useMemo(() => {
        const resolved: ResolvedMedia[] = [];
        const links: Array<{ uri: string; label: string; href: string | null }> = [];
        props.media.forEach((item, index) => {
            const uri = item.url ?? (item.data ? `data:${item.mediaType};base64,${item.data}` : null);
            if (!uri) return;
            const kind = getMediaKind(uri, item.mediaType);
            if (kind === 'unknown') {
                links.push({ uri, label: item.name || uri, href: mediaFallbackLink(uri) });
                return;
            }
            resolved.push({ ...item, uri, kind, displayName: mediaDisplayName(item, uri, index) });
        });
        return { resolved, links };
    }, [props.media]);
    const active = activeIndex === null ? null : resolved[activeIndex];
    const retainedActive = retainedIndex === null ? null : resolved[retainedIndex];
    const openViewer = React.useCallback((index: number) => {
        setToolbarError(null);
        setPreviewSuspended(false);
        setRetainedIndex(index);
        setActiveIndex(index);
    }, []);
    React.useEffect(() => { setPreviewSuspended(false); }, [activeIndex]);

    const suspendPlaybackForDownload = () => {
        if (retainedActive?.kind !== 'video' && retainedActive?.kind !== 'audio') return;
        // pause() alone can leave the browser buffering. Release both the
        // element's source and the player/renewal lease before downloading.
        viewerRef.current?.querySelectorAll<HTMLMediaElement>('audio,video').forEach(media => {
            media.pause();
            media.removeAttribute('src');
            media.querySelectorAll('source').forEach(source => source.removeAttribute('src'));
            media.load();
        });
        setPreviewSuspended(true);
    };

    const downloadFromViewer = async (item: ResolvedMedia) => {
        downloadRunning.current = true;
        setDownloadPreparing(true);
        setToolbarError(null);
        try {
            const workspace = item.workspaceVideo ?? item.workspaceFile;
            if (workspace) {
                const { downloadWorkspaceFile } = await import('@/utils/workspaceFileTransfer');
                await downloadWorkspaceFile({ ...workspace });
            } else if (storedCloudPath(item.uri)) await downloadStoredFile(item.uri, item.displayName);
            else await downloadCloudFileLink(item.uri, item.displayName);
        } catch (error) {
            setToolbarError(error instanceof Error ? error.message : '下载失败，请重试');
        } finally {
            downloadRunning.current = false;
            setDownloadPreparing(false);
        }
    };
    const closeViewer = React.useCallback(() => {
        viewerRef.current?.querySelectorAll<HTMLMediaElement>('audio,video').forEach((media) => media.pause());
        setActiveIndex(null);
        setRetainedIndex(null);
    }, []);

    React.useEffect(() => {
        const restored = (event: PageTransitionEvent) => { if (event.persisted) closeViewer(); };
        window.addEventListener('pagehide', closeViewer);
        window.addEventListener('pageshow', restored);
        return () => { window.removeEventListener('pagehide', closeViewer); window.removeEventListener('pageshow', restored); };
    }, [closeViewer]);

    React.useEffect(() => {
        if (activeIndex === null) {
            return;
        }
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                closeViewer();
            } else if (event.key === 'ArrowRight') {
                setActiveIndex((current) => {
                    if (current === null) return null;
                    const next = Math.min(current + 1, resolved.length - 1);
                    setRetainedIndex(next);
                    return next;
                });
            } else if (event.key === 'ArrowLeft') {
                setActiveIndex((current) => {
                    if (current === null) return null;
                    const next = Math.max(current - 1, 0);
                    setRetainedIndex(next);
                    return next;
                });
            }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [activeIndex, closeViewer, resolved.length]);

    React.useEffect(() => {
        if (activeIndex === null) return;
        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => {
            document.body.style.overflow = previousOverflow;
        };
    }, [activeIndex]);


    if (resolved.length === 0 && links.length === 0) {
        return null;
    }

    return (
        <>
            {links.map((item, index) => item.href ? (
                <a
                    key={`${item.uri.slice(0, 64)}:${index}`}
                    href={item.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: theme.colors.text, overflowWrap: 'anywhere', display: 'block', marginBottom: 8 }}
                >{item.label}</a>
            ) : <span key={`${item.uri.slice(0, 64)}:${index}`} style={{ color: theme.colors.text, overflowWrap: 'anywhere' }}>{item.label}</span>)}
            {resolved.length > 0 ? <View style={{
                width: '100%',
                display: compact ? 'flex' : 'grid',
                flexDirection: compact ? 'row' : undefined,
                gridTemplateColumns: compact ? undefined : resolved.length === 1 ? 'minmax(0, 1fr)' : 'repeat(2, minmax(0, 1fr))',
                gap: 8,
                marginBottom: grouped ? 0 : 8,
                overflowX: compact ? 'auto' : 'visible',
                scrollSnapType: compact ? 'x mandatory' : undefined,
                overscrollBehaviorX: compact ? 'contain' : undefined,
            } as any}>
                {resolved.map((item, index) => (
                    <View key={`${item.uri.slice(0, 64)}:${index}`} style={{
                        minWidth: compact ? (resolved.length === 1 ? '100%' : '82%') : 0,
                        width: compact ? (resolved.length === 1 ? '100%' : '82%') : undefined,
                        flexShrink: 0,
                        scrollSnapAlign: compact ? 'start' : undefined,
                    } as any}>
                    <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Open ${item.kind}`}
                        onPress={() => openViewer(index)}
                        style={{
                            position: 'relative',
                            width: '100%',
                            minHeight: item.kind === 'audio' ? 66 : item.kind === 'image' ? 96 : undefined,
                            overflow: 'hidden',
                            borderRadius: 8,
                            backgroundColor: theme.colors.surfaceHigh,
                        } as any}
                    >
                        <BrowserMedia item={item} thumbnail />
                        {item.workspaceVideo || item.kind === 'video' ? null : <a
                            {...(item.workspaceFile || storedCloudPath(item.uri) || isCloudFileLink(item.uri) ? { href: '#' } : browserDownloadAttributes(item.uri, item.displayName))}
                            aria-label={`下载 ${item.displayName}`}
                            onClick={(event) => {
                                event.stopPropagation();
                                if (item.workspaceFile) {
                                    event.preventDefault();
                                    void import('@/utils/workspaceFileTransfer').then(({ downloadWorkspaceFile }) => downloadWorkspaceFile(item.workspaceFile!)).catch(() => undefined);
                                } else if (storedCloudPath(item.uri)) { event.preventDefault(); void downloadStoredFile(item.uri, item.displayName).catch(() => undefined); }
                                else if (isCloudFileLink(item.uri)) { event.preventDefault(); void downloadCloudFileLink(item.uri, item.displayName).catch(() => undefined); }
                            }}
                            style={mediaStyles.cardDownload}
                        >
                            <Ionicons name="download-outline" size={18} color="#FFF" />
                        </a>}
                    </Pressable>
                    {item.kind === 'video' ? <VideoDownloadAction item={item} /> : null}
                    </View>
                ))}
            </View> : null}

            {retainedActive ? createPortal(
                <div
                    ref={viewerRef}
                    role="dialog"
                    aria-modal={activeIndex !== null}
                    aria-hidden={activeIndex === null}
                    aria-label={`${retainedActive.displayName} 媒体查看器`}
                    style={{
                        position: 'fixed',
                        inset: 0,
                        zIndex: 10000,
                        display: activeIndex === null ? 'none' : 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        paddingTop: compact ? 'max(8px, env(safe-area-inset-top))' : 32,
                        paddingRight: compact ? 8 : 32,
                        paddingBottom: compact ? 'max(8px, env(safe-area-inset-bottom))' : 32,
                        paddingLeft: compact ? 8 : 32,
                        backgroundColor: 'rgba(8,10,12,0.94)',
                    } as any}
                >
                    <div style={mediaStyles.viewerToolbar}>
                        <div style={{ ...mediaStyles.viewerIdentity, maxWidth: compact ? 112 : 'min(48vw, 520px)' }}>
                            <span style={mediaStyles.viewerName}>{retainedActive.displayName}</span>
                            <span style={mediaStyles.viewerMeta}>{retainedActive.mediaType || retainedActive.kind}</span>
                        </div>
                        {toolbarError ? <span role="alert" style={{ color: '#ffb4b4', fontSize: theme.typography.caption.fontSize }}>{toolbarError}</span> : null}
                        <a {...(retainedActive.workspaceVideo || retainedActive.workspaceFile || storedCloudPath(retainedActive.uri) || isCloudFileLink(retainedActive.uri) ? { href: '#' } : browserDownloadAttributes(retainedActive.uri, retainedActive.displayName))} onClick={(event) => {
                            if (downloadRunning.current) { event.preventDefault(); return; }
                            suspendPlaybackForDownload();
                            if (retainedActive.workspaceVideo || retainedActive.workspaceFile || storedCloudPath(retainedActive.uri) || isCloudFileLink(retainedActive.uri)) {
                                event.preventDefault();
                                void downloadFromViewer(retainedActive);
                            }
                        }} aria-disabled={downloadPreparing} aria-busy={downloadPreparing} title="下载时停止预览缓冲；交给浏览器后可关闭页面" style={{ ...mediaStyles.viewerAction, padding: compact ? '0 11px' : '0 13px', opacity: downloadPreparing ? 0.6 : 1 }} aria-label={`下载 ${retainedActive.displayName}`}>
                            <Ionicons name="download-outline" size={19} color="#FFF" />
                            {!compact ? <span>{downloadPreparing ? '准备中…' : '下载'}</span> : null}
                        </a>
                        {!retainedActive.workspaceVideo && !storedCloudPath(retainedActive.uri) && !retainedActive.uri.startsWith('data:') ? (
                            <a href={retainedActive.uri} target="_blank" rel="noopener noreferrer" onClick={isCloudFileLink(retainedActive.uri) ? event => {
                                event.preventDefault(); setToolbarError(null);
                                void openCloudFileLink(retainedActive.uri).catch(error => setToolbarError(error instanceof Error ? error.message : '视频打开失败，请重试'));
                            } : undefined} style={mediaStyles.viewerAction} aria-label={`在新标签页打开 ${retainedActive.displayName}`}>
                                <Ionicons name="open-outline" size={18} color="#FFF" />
                                {!compact ? <span>新窗口</span> : null}
                            </a>
                        ) : null}
                    </div>
                    <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="Close media viewer"
                        onPress={closeViewer}
                        style={{
                            position: 'absolute',
                            top: compact ? 'max(8px, env(safe-area-inset-top))' : 20,
                            right: compact ? 8 : 20,
                            width: 44,
                            height: 44,
                            borderRadius: 10,
                            alignItems: 'center',
                            justifyContent: 'center',
                            backgroundColor: 'rgba(255,255,255,0.12)',
                            zIndex: 2,
                        } as any}
                    >
                        <Ionicons name="close" size={25} color="#FFF" />
                    </Pressable>
                    <View style={{ width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center' }}>
                        {previewSuspended ? <div style={{ display: 'grid', justifyItems: 'center', gap: 16, padding: 24, color: '#d1e0e9', fontSize: theme.typography.label.fontSize }}>
                            <span role="status">{downloadPreparing ? '正在准备下载，已停止预览缓冲' : '已停止预览缓冲'}</span>
                            <button type="button" disabled={downloadPreparing} onClick={() => setPreviewSuspended(false)} style={{ ...mediaStyles.viewerAction, border: 0, padding: '0 18px', fontFamily: 'inherit', cursor: downloadPreparing ? 'default' : 'pointer', opacity: downloadPreparing ? 0.5 : 1 }}>继续预览</button>
                        </div> : <BrowserMedia item={retainedActive} />}
                    </View>
                    {resolved.length > 1 ? (
                        <>
                            <MediaNavigationButton
                                direction="previous"
                                compact={compact}
                                disabled={activeIndex === 0}
                                onPress={() => setActiveIndex((current) => {
                                    if (current === null) return null;
                                    const next = Math.max(0, current - 1);
                                    setRetainedIndex(next);
                                    return next;
                                })}
                            />
                            <MediaNavigationButton
                                direction="next"
                                compact={compact}
                                disabled={activeIndex === resolved.length - 1}
                                onPress={() => setActiveIndex((current) => {
                                    if (current === null) return null;
                                    const next = Math.min(resolved.length - 1, current + 1);
                                    setRetainedIndex(next);
                                    return next;
                                })}
                            />
                            <View style={{
                                position: 'absolute',
                                top: compact ? 'max(66px, calc(env(safe-area-inset-top) + 58px))' : undefined,
                                bottom: compact ? undefined : 22,
                                paddingHorizontal: 10,
                                paddingVertical: 5,
                                borderRadius: 8,
                                backgroundColor: 'rgba(255,255,255,0.12)',
                            } as any}>
                                <span style={{ color: '#FFF', font: '600 12px IBMPlexSans, sans-serif' }}>
                                    {(activeIndex ?? 0) + 1} / {resolved.length}
                                </span>
                            </View>
                        </>
                    ) : null}
                </div>,
                document.body,
            ) : null}
        </>
    );
}

function MediaNavigationButton(props: {
    direction: 'previous' | 'next';
    compact: boolean;
    disabled: boolean;
    onPress: () => void;
}) {
    const previous = props.direction === 'previous';
    return (
        <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${props.direction} media`}
            accessibilityState={{ disabled: props.disabled }}
            disabled={props.disabled}
            onPress={props.onPress}
            style={{
                position: 'absolute',
                left: previous ? (props.compact ? 8 : 24) : undefined,
                right: previous ? undefined : (props.compact ? 8 : 24),
                bottom: undefined,
                top: '50%',
                width: 46,
                height: 46,
                borderRadius: 12,
                alignItems: 'center',
                justifyContent: 'center',
                opacity: props.disabled ? 0.28 : 1,
                backgroundColor: 'rgba(255,255,255,0.12)',
            } as any}
        >
            <Ionicons name={previous ? 'chevron-back' : 'chevron-forward'} size={25} color="#FFF" />
        </Pressable>
    );
}

function BrowserMedia(props: { item: ResolvedMedia; thumbnail?: boolean }) {
    const { theme } = useUnistyles();
    const mediaStyles = getMediaStyles(theme);
    const [failed, setFailed] = React.useState<string | null>(null);
    const [attempt, setAttempt] = React.useState(0);
    const preview = props.item.kind === 'image' ? storedImagePreviewUrl(props.item.uri) : null;
    React.useEffect(() => setFailed(null), [props.item.uri, attempt]);

    if (failed) {
        const feedback = (
            <div role="alert" style={{ ...mediaStyles.failure, ...(props.thumbnail ? { minHeight: 120 } : {}), ...(preview && !props.thumbnail ? { position: 'absolute' as const, bottom: 16, left: 16, width: 'calc(100% - 32px)', height: 'auto', minHeight: 0, padding: 12, borderRadius: 10 } : {}) }}>
                <Ionicons name="alert-circle-outline" size={24} color="#FFF" />
                <span style={mediaStyles.failureText}>{failed}</span>
                {props.thumbnail ? (
                    <span
                        style={mediaStyles.retryButton}
                        onClick={(event) => { event.stopPropagation(); setAttempt((value) => value + 1); }}
                    >
                        重试
                    </span>
                ) : (
                    <button type="button" style={mediaStyles.retryButton} onClick={() => setAttempt((value) => value + 1)}>重试</button>
                )}
            </div>
        );
        return preview && !props.thumbnail ? <div style={{ position: 'relative', width: '100%', height: '100%' }}><ZoomableImage src={preview} onError={() => undefined} />{feedback}</div> : feedback;
    }

    if (props.item.kind === 'audio') {
        return <CloudMediaSource key={attempt} forceRefresh={attempt > 0} uri={props.item.uri} onError={setFailed}>{(url, source) => <PlayableMedia item={{ ...props.item, uri: url }} attach={source?.attach} thumbnail={props.thumbnail} onError={setFailed} />}</CloudMediaSource>;
    }

    if (props.item.kind === 'video') {
        return props.thumbnail ? <VideoCard item={props.item} /> : <VideoPlayer key={`${props.item.uri}:${attempt}`} item={props.item} onError={setFailed} forceRefresh={attempt > 0} />;
    }

    const renderImage = (url: string) => props.thumbnail ? React.createElement('img', {
        key: `${url}:${attempt}`,
        src: url,
        alt: '',
        loading: props.thumbnail ? 'lazy' : 'eager',
        decoding: 'async',
        onError: () => setFailed('图片无法加载，请检查地址或文件格式'),
        style: {
            width: '100%',
            height: 'auto',
            maxHeight: 'min(240px, 35vh)',
            display: 'block',
            objectFit: 'contain',
            userSelect: 'none',
        },
    }) : <ZoomableImage src={url} previewSrc={preview ?? undefined} onError={() => setFailed('原图暂时无法加载，请重试或下载')} />;
    // A conversation card must not enqueue the full original merely to show
    // an image. Opening/downloading still resolves the original through R2.
    if (preview && props.thumbnail) return <div data-stored-image-preview>{renderImage(preview)}</div>;
    return <CloudMediaSource key={attempt} forceRefresh={attempt > 0} uri={props.item.uri} onError={setFailed}
        waitingPreview={preview ? <ZoomableImage src={preview} onError={() => undefined} /> : undefined}>{renderImage}</CloudMediaSource>;
}

function PlayableMedia(props: {
    item: ResolvedMedia;
    thumbnail?: boolean;
    attach?: CloudMediaAttachment;
    onError: (message: string) => void;
}) {
    const ref = React.useRef<HTMLMediaElement | null>(null);
    React.useEffect(() => {
        const media = ref.current;
        const detach = media ? props.attach?.(media, props.onError) : undefined;
        return () => {
            detach?.();
            if (!media) return;
            media.pause();
            media.removeAttribute('src');
            media.load();
        };
    }, [props.item.uri, props.attach, props.onError]);
    const handleError = (event: React.SyntheticEvent<HTMLMediaElement>) => {
        const code = event.currentTarget.error?.code;
        props.onError(code === 4 ? '浏览器不支持此媒体编码，可下载后查看' : '媒体无法加载，请检查网络或文件');
    };
    return (
            <audio
                ref={(element) => { ref.current = element; }}
                src={props.item.uri}
                aria-label={props.item.displayName}
                controls
                preload="metadata"
                onError={handleError}
                style={{ width: props.thumbnail ? 'calc(100% - 12px)' : 'calc(100% - 24px)', minHeight: 54, margin: props.thumbnail ? 6 : 12 }}
            />
    );
}

export function ZoomableImage(props: { src: string; previewSrc?: string; onError: () => void }) {
    const { theme } = useUnistyles();
    const mediaStyles = getMediaStyles(theme);
    const imageRef = React.useRef<HTMLImageElement | null>(null);
    const [loadedSrc, setLoadedSrc] = React.useState<string | null>(null);
    const showPreview = Boolean(props.previewSrc && props.previewSrc !== props.src && loadedSrc !== props.src);
    const pointers = React.useRef(new Map<number, { x: number; y: number }>());
    const transform = React.useRef({ scale: 1, x: 0, y: 0 });
    const gesture = React.useRef<{ distance: number; scale: number } | null>(null);

    const renderTransform = React.useCallback(() => {
        const image = imageRef.current;
        if (!image) return;
        const value = transform.current;
        image.style.transform = `translate3d(${value.x}px, ${value.y}px, 0) scale(${value.scale})`;
        image.style.cursor = value.scale > 1 ? 'grab' : 'zoom-in';
    }, []);
    const reset = React.useCallback(() => {
        transform.current = { scale: 1, x: 0, y: 0 };
        renderTransform();
    }, [renderTransform]);
    const zoomAt = React.useCallback((nextScale: number, clientX: number, clientY: number) => {
        const image = imageRef.current;
        if (!image) return;
        const previous = transform.current;
        const scale = Math.min(5, Math.max(1, nextScale));
        const rect = image.getBoundingClientRect();
        const anchorX = clientX - (rect.left + rect.width / 2);
        const anchorY = clientY - (rect.top + rect.height / 2);
        const ratio = scale / previous.scale;
        transform.current = {
            scale,
            x: scale === 1 ? 0 : previous.x - anchorX * (ratio - 1),
            y: scale === 1 ? 0 : previous.y - anchorY * (ratio - 1),
        };
        renderTransform();
    }, [renderTransform]);

    return (
        <div
            style={mediaStyles.zoomStage}
            onWheel={(event) => {
                event.preventDefault();
                zoomAt(transform.current.scale * (event.deltaY < 0 ? 1.18 : 0.84), event.clientX, event.clientY);
            }}
            onDoubleClick={(event) => zoomAt(transform.current.scale > 1 ? 1 : 2.25, event.clientX, event.clientY)}
            onPointerDown={(event) => {
                event.currentTarget.setPointerCapture(event.pointerId);
                pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
                if (pointers.current.size === 2) {
                    const [a, b] = [...pointers.current.values()];
                    gesture.current = { distance: Math.hypot(a.x - b.x, a.y - b.y), scale: transform.current.scale };
                }
            }}
            onPointerMove={(event) => {
                const previous = pointers.current.get(event.pointerId);
                if (!previous) return;
                pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
                if (pointers.current.size === 2) {
                    const [a, b] = [...pointers.current.values()];
                    const distance = Math.hypot(a.x - b.x, a.y - b.y);
                    const centerX = (a.x + b.x) / 2;
                    const centerY = (a.y + b.y) / 2;
                    if (gesture.current) zoomAt(gesture.current.scale * distance / Math.max(1, gesture.current.distance), centerX, centerY);
                } else if (transform.current.scale > 1) {
                    transform.current.x += event.clientX - previous.x;
                    transform.current.y += event.clientY - previous.y;
                    renderTransform();
                }
            }}
            onPointerUp={(event) => {
                pointers.current.delete(event.pointerId);
                gesture.current = null;
            }}
            onPointerCancel={(event) => {
                pointers.current.delete(event.pointerId);
                gesture.current = null;
            }}
        >
            {showPreview ? <img src={props.previewSrc} alt="" aria-hidden="true" draggable={false} style={{ ...mediaStyles.zoomImage, gridArea: '1 / 1', pointerEvents: 'none' }} /> : null}
            <img ref={imageRef} src={props.src} alt="" draggable={false} onLoad={() => setLoadedSrc(props.src)} onError={props.onError} style={{ ...mediaStyles.zoomImage, gridArea: '1 / 1', opacity: showPreview ? 0 : 1 }} />
            <button type="button" aria-label="重置图片缩放" style={mediaStyles.resetButton} onClick={(event) => { event.stopPropagation(); reset(); }}>1:1</button>
        </div>
    );
}

const getMediaStyles = (theme: Theme): Record<string, React.CSSProperties> => ({
    failure: { width: '100%', height: '100%', minHeight: 180, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 9, background: '#15171a' },
    failureText: { color: '#FFF', fontSize: theme.typography.small.fontSize },
    retryButton: { minHeight: 44, padding: '0 14px', border: '1px solid rgba(255,255,255,.24)', borderRadius: 9, background: 'rgba(255,255,255,.12)', color: '#FFF', cursor: 'pointer' },
    zoomStage: { position: 'relative', width: '100%', height: '100%', display: 'grid', placeItems: 'center', overflow: 'hidden', touchAction: 'none' },
    zoomImage: { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', userSelect: 'none', transformOrigin: 'center', willChange: 'transform' },
    resetButton: { position: 'absolute', right: 8, bottom: 8, minWidth: 44, minHeight: 44, border: '1px solid rgba(255,255,255,.2)', borderRadius: 9, background: 'rgba(0,0,0,.56)', color: '#FFF', fontSize: theme.typography.caption.fontSize, cursor: 'pointer' },
    cardDownload: { position: 'absolute', top: 8, right: 8, width: 44, height: 44, borderRadius: 9, display: 'grid', placeItems: 'center', background: 'rgba(0,0,0,.64)', textDecoration: 'none', zIndex: 2 },
    viewerToolbar: { position: 'absolute', top: 'max(8px, env(safe-area-inset-top))', left: 8, right: 60, minHeight: 44, display: 'flex', alignItems: 'center', gap: 8, zIndex: 3 },
    viewerIdentity: { minWidth: 0, padding: '5px 10px', borderRadius: 9, background: 'rgba(0,0,0,.48)', display: 'flex', flexDirection: 'column' },
    viewerName: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#FFF', fontSize: theme.typography.small.fontSize, fontWeight: 600 },
    viewerMeta: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'rgba(255,255,255,.66)', fontSize: theme.typography.caption.fontSize },
    viewerAction: { minWidth: 44, minHeight: 44, flexShrink: 0, padding: '0 11px', borderRadius: 9, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, background: 'rgba(255,255,255,.12)', color: '#FFF', textDecoration: 'none', fontSize: theme.typography.caption.fontSize, fontWeight: 600 },
});
