import * as React from 'react';
import { useWindowDimensions } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { browserDownloadAttributes } from '@/utils/browserDownload';
import { downloadStoredFile, downloadCloudFileLink, isCloudFileLink, storedCloudPath } from '@/utils/cloudFileDelivery';
import { peekVideoPreview, subscribeVideoPreview } from './videoPreview';
import type { VideoItem } from './VideoCard.web';

/** A sibling of the preview card: saving must never open the player. */
export function VideoDownloadAction({ item }: { item: VideoItem }) {
    const { theme } = useUnistyles();
    const actionHeight = useWindowDimensions().width > 700 ? 32 : 44;
    const [preview, setPreview] = React.useState(() => peekVideoPreview(item) ?? item.video);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const running = React.useRef(false);
    const mounted = React.useRef(true);
    React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    React.useEffect(() => {
        setPreview(peekVideoPreview(item) ?? item.video);
        setError(null);
        return subscribeVideoPreview(item, () => setPreview(peekVideoPreview(item) ?? item.video));
    }, [item.uri, item.workspaceVideo?.sessionId, item.workspaceVideo?.path, item.previewRevision, item.video]);

    const workspace = item.workspaceVideo ?? item.workspaceFile;
    const managed = Boolean(workspace || storedCloudPath(item.uri) || isCloudFileLink(item.uri));
    const expired = !managed && preview?.reason === 'source_expired';
    let direct: ReturnType<typeof browserDownloadAttributes> | undefined;
    if (!managed && !expired) {
        try { direct = browserDownloadAttributes(item.uri, item.displayName); }
        catch { /* A missing workspace association must not crash the conversation. */ }
    }
    const unavailable = !managed && !direct;
    const download = async () => {
        if (running.current) return;
        running.current = true; setBusy(true); setError(null);
        try {
            if (workspace) {
                const { downloadWorkspaceFile } = await import('@/utils/workspaceFileTransfer');
                await downloadWorkspaceFile(workspace);
            } else if (storedCloudPath(item.uri)) await downloadStoredFile(item.uri, item.displayName);
            else await downloadCloudFileLink(item.uri, item.displayName);
        } catch (problem) {
            if (mounted.current) setError(problem instanceof Error ? problem.message : '下载准备失败，请重试');
        } finally {
            running.current = false;
            if (mounted.current) setBusy(false);
        }
    };
    const style: React.CSSProperties = {
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7,
        minHeight: actionHeight, padding: '0 10px', boxSizing: 'border-box', borderRadius: 7,
        border: `1px solid ${theme.colors.divider}`, background: theme.colors.surfaceHigh,
        color: theme.colors.text, fontFamily: 'inherit', fontSize: theme.typography.caption.fontSize, fontWeight: 600,
        textDecoration: 'none', cursor: busy || unavailable ? 'default' : 'pointer',
        opacity: unavailable ? .5 : 1, flexShrink: 0,
    };
    const content = <>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M12 3v12m-4-4 4 4 4-4M5 14v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span>{busy ? '准备下载…' : '下载原视频'}</span>
    </>;
    return <div data-video-download-action style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-end', gap: 6, paddingTop: 4 }}>
        {expired ? <span role="status" style={{ color: theme.colors.textSecondary, fontSize: theme.typography.caption.fontSize }}>链接已过期，请更新链接</span> : null}
        {unavailable && !expired ? <span role="status" style={{ color: theme.colors.textSecondary, fontSize: theme.typography.caption.fontSize }}>缺少可下载的原文件地址</span> : null}
        {error ? <span role="alert" style={{ color: theme.colors.textDestructive, fontSize: theme.typography.caption.fontSize, flexBasis: '100%', overflowWrap: 'anywhere' }}>{error}</span> : null}
        {managed || unavailable ? <button type="button" disabled={busy || unavailable} aria-busy={busy} aria-label={`下载原视频 ${item.displayName}`} onClick={event => { event.stopPropagation(); void download(); }} style={style}>{content}</button>
            : <a {...direct} aria-label={`下载原视频 ${item.displayName}`} onClick={event => event.stopPropagation()}
                title="使用浏览器下载；若源站打开视频，可使用浏览器保存原文件" style={style}>{content}</a>}
    </div>;
}
