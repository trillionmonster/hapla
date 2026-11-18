import * as React from 'react';
import { Linking, Platform, Pressable, View, useWindowDimensions } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { downloadWorkspaceFile, formatFileSize } from '@/utils/workspaceFileTransfer';
import type { ToolViewProps } from './_all';
import { storage } from '@/sync/storage';
import { useRouter } from 'expo-router';
import { encodeFileRoutePath } from '@/utils/isolatedFilePreview';
import { MediaGallery } from '@/components/media/MediaGallery';
import { resolveMediaSource } from '@/components/media/mediaSource';
import { handOffBrowserDownload } from '@/utils/browserDownload';
import { getFilePreviewKind } from '@/utils/filePreview';
import { getMediaDisplayName } from '@/components/media/mediaDisplayName';
import { useGroupedArtifact } from '@/components/ArtifactPresentation';

export const FileArtifactView = React.memo(function FileArtifactView(props: ToolViewProps) {
    const { theme } = useUnistyles();
    const grouped = useGroupedArtifact();
    const width = useWindowDimensions().width;
    const actionHeight = Platform.OS === 'web' && width > 700 ? 32 : 44;
    const router = useRouter();
    const [progress, setProgress] = React.useState<number | null>(null);
    const rawRef = typeof props.tool.input?.ref === 'string' ? props.tool.input.ref : '';
    const { url: ref, name, direct, localFile, mediaType, workspaceVideo } = resolveMediaSource(rawRef, {
        sessionId: props.sessionId,
        sessionRoot: props.sessionId ? storage.getState().sessions[props.sessionId]?.metadata?.path : null,
        name: typeof props.tool.input?.name === 'string' ? props.tool.input.name : undefined,
        declaredType: typeof props.tool.input?.mimeType === 'string' ? props.tool.input.mimeType : undefined,
    });
    const canPreview = getFilePreviewKind(localFile?.absolutePath ?? getMediaDisplayName(ref)) !== 'binary'
        && getFilePreviewKind(name) !== 'binary';
    const size = typeof props.tool.input?.size === 'number' ? props.tool.input.size : 0;
    const video = mediaType.startsWith('video/') && ref && (direct || workspaceVideo) ? {
        url: ref, mediaType, name, ...(size > 0 ? { size } : {}), workspaceVideo, previewRevision: String(props.tool.createdAt),
    } : null;

    const download = React.useCallback(async () => {
        if (direct) {
            try { handOffBrowserDownload(ref, name); }
            catch (error) { Modal.alert('下载失败', error instanceof Error ? error.message : '无法打开下载'); }
            return;
        }
        if (!props.sessionId || !ref || progress !== null) return;
        setProgress(0);
        try {
            // Artifact refs are resolved against the session workspace. The
            // machine RPC is rooted at the daemon process cwd, which may be a
            // different directory and incorrectly rejects valid session files
            // as being outside the workspace.
            try {
                await downloadWorkspaceFile({ sessionId: props.sessionId, path: ref, onProgress: setProgress });
            } catch (error) {
                const machineId = storage.getState().sessions[props.sessionId]?.metadata?.machineId;
                if (!machineId || !(error instanceof Error) || error.message !== 'RPC method not available') throw error;
                await downloadWorkspaceFile({ machineId, path: ref, onProgress: setProgress });
            }
        } catch (error) {
            if (!(error instanceof Error && error.name === 'AbortError')) Modal.alert('下载失败', error instanceof Error ? error.message : '无法下载此文件');
        } finally {
            setProgress(null);
        }
    }, [progress, props.sessionId, ref, direct, name]);

    // The media card already owns video preview/open/download actions. Do not
    // repeat a file toolbar underneath it or route an HTTP URL to local RPC.
    if (video) return <MediaGallery media={[video]} />;

    return (
        <View style={{ minWidth: 0, width: '100%' }}>
        <View style={[styles.container, { borderColor: theme.colors.divider, backgroundColor: theme.colors.surfaceHigh },
            grouped && { borderWidth: 0, borderRadius: 0, paddingHorizontal: 0, paddingLeft: 0, paddingVertical: 2, backgroundColor: 'transparent' }]}>
            <View style={styles.copy}>
                <Text numberOfLines={1} style={[styles.name, { color: theme.colors.text }]}>{name}</Text>
                <Text style={[styles.meta, { color: theme.colors.textSecondary }]}>{formatFileSize(size)}</Text>
            </View>
            {canPreview && <Pressable accessibilityRole="button" accessibilityLabel={`预览 ${name}`} disabled={!direct && !localFile?.withinSessionRoot}
                onPress={() => direct ? void Linking.openURL(ref) : router.push(`/session/${props.sessionId}/file?path=${encodeURIComponent(encodeFileRoutePath(localFile!.absolutePath))}`)}
                style={[styles.button, { minHeight: actionHeight, backgroundColor: theme.colors.surface }]}>
                <Ionicons name="eye-outline" size={15} color={theme.colors.textSecondary} />
                <Text style={[styles.buttonText, { color: theme.colors.text }]}>预览</Text>
            </Pressable>}
            <Pressable
                accessibilityRole="button"
                accessibilityLabel={`下载 ${name}`}
                disabled={progress !== null || (!direct && !localFile?.withinSessionRoot)}
                onPress={download}
                style={({ pressed }) => [
                    styles.button,
                    { minHeight: actionHeight, backgroundColor: theme.colors.surface },
                    pressed && styles.pressed,
                ]}
            >
                {progress === null
                    ? <Ionicons name="download-outline" size={15} color={theme.colors.textSecondary} />
                    : <Text style={[styles.percent, { color: theme.colors.text }]}>{Math.round(progress * 100)}%</Text>}
                <Text style={[styles.buttonText, { color: theme.colors.text }]}>{progress === null ? '下载' : '下载中'}</Text>
            </Pressable>
        </View>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: { minHeight: 42, borderWidth: 1, borderRadius: 8, padding: 5, paddingLeft: 10, flexDirection: 'row', alignItems: 'center', gap: 6 },
    copy: { flex: 1, minWidth: 0 },
    name: { ...Typography.default('semiBold'), fontSize: theme.typography.small.fontSize, lineHeight: theme.typography.small.lineHeight },
    meta: { ...Typography.default(), fontSize: theme.typography.caption.fontSize, lineHeight: theme.typography.caption.lineHeight },
    button: { minHeight: 44, minWidth: 54, borderRadius: 6, paddingHorizontal: 9, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5 },
    buttonText: { ...Typography.default('semiBold'), fontSize: theme.typography.caption.fontSize },
    percent: { ...Typography.mono(), fontSize: theme.typography.code.fontSize },
    pressed: { opacity: 0.7, transform: [{ scale: 0.98 }] },
}));
