import * as React from 'react';
import { Pressable, View } from 'react-native';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { useUnistyles } from 'react-native-unistyles';
import type { FilePreviewKind } from '@/utils/filePreview';
import type { WorkspaceVideoLease } from '@/utils/workspaceVideoCache';
import type { CloudMediaAttachment } from '@/utils/cloudFileDelivery';

function base64ToBlobUrl(base64: string, mimeType: string): string {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }
    return URL.createObjectURL(new Blob([bytes], { type: mimeType }));
}

export function FileMediaPreview(props: {
    base64?: string;
    url?: string;
    attachVideo?: WorkspaceVideoLease['attach'];
    attachMedia?: CloudMediaAttachment;
    onError?: (message: string) => void;
    fileName: string;
    kind: Exclude<FilePreviewKind, 'text' | 'binary'>;
    mimeType: string;
}) {
    const { theme } = useUnistyles();
    const [objectUrl, setObjectUrl] = React.useState<string | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [attempt, setAttempt] = React.useState(0);
    const mediaRef = React.useRef<HTMLMediaElement | HTMLImageElement | HTMLIFrameElement | null>(null);
    const detachVideo = React.useRef<(() => void) | undefined>(undefined);
    const reportError = React.useRef<(message: string) => void>(() => {});
    reportError.current = (message) => props.onError ? props.onError(message) : setError(message);
    const setMediaRef = React.useCallback((element: HTMLMediaElement | HTMLImageElement | HTMLIFrameElement | null) => {
        const media = mediaRef.current;
        if (media === element) return;
        detachVideo.current?.();
        detachVideo.current = undefined;
        if (media) {
            if (media instanceof HTMLMediaElement) media.pause();
            media.removeAttribute('src');
            if (media instanceof HTMLMediaElement) media.load();
        }
        mediaRef.current = element;
        if (element instanceof HTMLMediaElement && props.attachMedia) {
            try { detachVideo.current = props.attachMedia(element, message => reportError.current(message)); }
            catch (problem) { reportError.current(problem instanceof Error ? problem.message : '媒体无法连接，请重试'); }
        } else if (element instanceof HTMLVideoElement && props.attachVideo) {
            try { detachVideo.current = props.attachVideo(element, message => reportError.current(message)); }
            catch (problem) { reportError.current(problem instanceof Error ? problem.message : '视频流无法连接播放器，请重试'); }
        }
    }, [props.attachVideo, props.attachMedia]);

    React.useEffect(() => {
        // Release decoders synchronously before the browser freezes a cached
        // page; the file screen reloads its URL when that page is restored.
        const discard = () => setMediaRef(null);
        window.addEventListener('pagehide', discard);
        return () => window.removeEventListener('pagehide', discard);
    }, [setMediaRef]);

    React.useEffect(() => {
        if (props.url) {
            setObjectUrl(props.url);
            setError(null);
            return;
        }
        try {
            const nextUrl = base64ToBlobUrl(props.base64 || '', props.mimeType);
            setObjectUrl(nextUrl);
            setError(null);
            return () => URL.revokeObjectURL(nextUrl);
        } catch (nextError) {
            setError(nextError instanceof Error ? nextError.message : 'Could not prepare this file for preview');
            setObjectUrl(null);
        }
    }, [props.base64, props.mimeType, props.url, attempt]);

    if (error) {
        return (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
                <Text style={{ color: theme.colors.textDestructive, textAlign: 'center', ...Typography.default() }}>{error}</Text>
                <Pressable accessibilityRole="button" accessibilityLabel="重试媒体预览" onPress={() => setAttempt(value => value + 1)} style={{ minHeight: 44, justifyContent: 'center' }}><Text style={{ color: theme.colors.text }}>重试</Text></Pressable>
            </View>
        );
    }
    if (!objectUrl) return null;

    if (props.kind === 'image') {
        return (
            <div style={{ display: 'flex', flex: 1, minHeight: 0, alignItems: 'center', justifyContent: 'center', overflow: 'auto', padding: 'clamp(8px, 3vw, 20px)' }}>
                <img
                    key={attempt}
                    ref={setMediaRef}
                    onError={() => setError('图片无法加载，请重试或下载查看')}
                    src={objectUrl}
                    alt={props.fileName}
                    decoding="async"
                    style={{ display: 'block', maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
                />
            </div>
        );
    }
    if (props.kind === 'video') {
        return (
            <div style={{ display: 'flex', flex: 1, minHeight: 0, alignItems: 'center', justifyContent: 'center', padding: 'clamp(8px, 3vw, 20px)' }}>
                <video
                    key={attempt}
                    ref={setMediaRef}
                    onError={() => reportError.current('媒体无法加载或浏览器不支持此编码，请重试或下载查看')}
                    src={objectUrl}
                    aria-label={props.fileName}
                    controls
                    preload="metadata"
                    playsInline
                    style={{ display: 'block', width: 'min(960px, 100%)', maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', background: '#111315' }}
                />
            </div>
        );
    }
    if (props.kind === 'audio') {
        return (
            <div style={{ display: 'flex', flex: 1, minHeight: 0, alignItems: 'center', justifyContent: 'center', padding: 'clamp(12px, 4vw, 24px)' }}>
                <audio key={attempt} ref={setMediaRef} onError={() => setError('媒体无法加载或浏览器不支持此编码，请重试或下载查看')} src={objectUrl} aria-label={props.fileName} controls preload="metadata" style={{ width: 'min(640px, 100%)' }} />
            </div>
        );
    }
    return (
        <iframe
            ref={setMediaRef}
            src={objectUrl}
            title={props.fileName}
            style={{ display: 'block', flex: 1, minHeight: 0, width: '100%', border: 0, background: theme.colors.surface }}
        />
    );
}
