import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { cancelDownload, dismissDownload, getDownloadJobs, retryDownload, subscribeDownloads } from '@/utils/downloadManager';
import { browserDownloadAttributes } from '@/utils/browserDownload';

export function DownloadManager() {
    const { theme } = useUnistyles();
    const jobs = React.useSyncExternalStore(subscribeDownloads, getDownloadJobs, getDownloadJobs);
    const [expanded, setExpanded] = React.useState(true);
    const [now, setNow] = React.useState(Date.now);
    const active = jobs.filter(job => job.state === 'queued' || job.state === 'running').length;
    React.useEffect(() => {
        if (!active) return;
        setNow(Date.now());
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [active]);
    if (!jobs.length) return null;
    const button: React.CSSProperties = { minWidth: 40, minHeight: 40, border: 0, borderRadius: 8, padding: '0 10px', background: 'transparent', color: theme.colors.text, cursor: 'pointer', fontSize: theme.typography.caption.fontSize };
    return <aside aria-label="下载管理" data-download-manager style={{ position: 'fixed', right: 12, bottom: 'max(12px, env(safe-area-inset-bottom))', zIndex: 12000, width: expanded ? 'min(350px, calc(100vw - 24px))' : undefined,
        background: theme.colors.surfaceHigh, color: theme.colors.text, border: `1px solid ${theme.colors.divider}`, borderRadius: 14, boxShadow: '0 6px 24px #0003', fontFamily: 'IBMPlexSans, sans-serif' }}>
        <button type="button" onClick={() => setExpanded(value => !value)} aria-expanded={expanded} style={{ ...button, width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 18, padding: '0 14px', fontSize: theme.typography.small.fontSize, fontWeight: 600 }}>
            <span>↓ 下载{active ? ` · ${active} 个准备中` : ''}</span><span aria-hidden="true">{expanded ? '−' : '+'}</span>
        </button>
        {expanded ? <div style={{ padding: '0 12px 10px' }}>
            {active ? <p style={{ margin: '0 2px 8px', color: theme.colors.textSecondary, fontSize: theme.typography.caption.fontSize, lineHeight: `${theme.typography.caption.lineHeight}px` }}>准备文件时请保留此标签页，可切换会话或关闭预览。交给浏览器后可离开页面。</p> : null}
            <div style={{ maxHeight: 280, overflowY: 'auto' }}>{jobs.slice().reverse().map(job => <div key={job.id} data-download-state={job.state} style={{ padding: '8px 0', borderTop: `1px solid ${theme.colors.divider}` }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{ minWidth: 0, flex: 1 }}>
                        <div title={job.name} style={{ fontSize: theme.typography.caption.fontSize, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{job.name}</div>
                        <div role="status" style={{ color: theme.colors.textSecondary, fontSize: theme.typography.caption.fontSize, lineHeight: `${theme.typography.caption.lineHeight}px` }}>{job.state === 'queued' ? '等待准备' : job.state === 'running' ? `${job.stage || '正在准备文件'} · 已等待 ${Math.max(0, Math.floor((now - (job.startedAt ?? now)) / 1000))} 秒` : job.state === 'handed-off' ? '下载请求已发送 · 请查看浏览器下载列表' : job.state === 'cancelled' ? '已取消' : job.error || '下载失败'}</div>
                        {job.state === 'handed-off' && job.browserUrl ? <a {...browserDownloadAttributes(job.browserUrl, job.name)} style={{ color: theme.colors.text, fontSize: theme.typography.caption.fontSize, lineHeight: `${theme.typography.caption.lineHeight}px` }}>未开始？点击这里下载</a> : null}
                    </div>
                    {job.state === 'queued' || job.state === 'running'
                        ? <button type="button" aria-label={`取消下载 ${job.name}`} style={button} onClick={() => cancelDownload(job.id)}>取消</button>
                        : <>{job.state === 'failed' || job.state === 'cancelled' ? <button type="button" aria-label={`重试下载 ${job.name}`} style={button} onClick={() => retryDownload(job.id)}>重试</button> : null}<button type="button" aria-label={`移除下载记录 ${job.name}`} style={button} onClick={() => dismissDownload(job.id)}>×</button></>}
                </div>
                {job.state === 'running' && now - (job.startedAt ?? now) >= 30_000 ? <div style={{ color: theme.colors.textSecondary, fontSize: theme.typography.caption.fontSize, lineHeight: `${theme.typography.caption.lineHeight}px`, paddingTop: 4 }}>准备完成后自动开始下载，可切换会话，无需重复点击。</div> : null}
            </div>)}</div>
        </div> : null}
    </aside>;
}
