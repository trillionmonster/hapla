import { useUnistyles } from 'react-native-unistyles';
import * as React from 'react';
import { acquireStoredCloudFile, acquireCloudFileLink, isCloudFileLink, cloudStageLabel, storedCloudPath, type CloudLinkLease } from '@/utils/cloudFileDelivery';
import type { CloudFileStage } from '@hapla/wire';

/** Mount for visible images/audio only; video cards keep their small covers. */
export function CloudMediaSource({ uri, onError, children, forceRefresh = false, waitingPreview }: {
    uri: string; forceRefresh?: boolean; waitingPreview?: React.ReactNode; onError: (message: string) => void; children: (url: string, source: CloudLinkLease | null) => React.ReactNode;
}) {
    const { theme } = useUnistyles();
    const path = storedCloudPath(uri);
    const cloud = isCloudFileLink(uri);
    const [attempt, setAttempt] = React.useState(0);
    const [result, setResult] = React.useState<{ uri: string; attempt: number; source: CloudLinkLease | null } | null>(null);
    const [stage, setStage] = React.useState<CloudFileStage>('preparing');
    const [elapsedSeconds, setElapsedSeconds] = React.useState(0);
    const root = React.useRef<HTMLDivElement>(null);
    React.useEffect(() => {
        if (!path && !cloud) return;
        const controller = new AbortController(); let source: CloudLinkLease | null = null; let started = false;
        let timer: ReturnType<typeof setInterval> | undefined;
        const stopWaiting = () => { if (timer !== undefined) { clearInterval(timer); timer = undefined; } };
        setStage('preparing'); setElapsedSeconds(0);
        const start = () => {
            if (started || controller.signal.aborted) return; started = true;
            const startedAt = Date.now();
            timer = setInterval(() => setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000)), 1000);
            const refresh = forceRefresh || attempt > 0;
            const options = { signal: controller.signal, onStage: (value: CloudFileStage) => { if (!controller.signal.aborted) setStage(value); }, force: refresh, forceRestore: refresh };
            void (path ? acquireStoredCloudFile(path, options) : acquireCloudFileLink(uri, options)).then(value => {
                stopWaiting(); source = value;
                if (controller.signal.aborted) { source?.release(); return; }
                setResult({ uri, attempt, source });
            }).catch(error => { stopWaiting(); if (!controller.signal.aborted) onError(error instanceof Error ? error.message : '文件准备失败，请重试'); });
        };
        const observer = typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { observer?.disconnect(); start(); } }, { rootMargin: '120px' }) : undefined;
        if (observer && root.current) observer.observe(root.current); else start();
        return () => { stopWaiting(); observer?.disconnect(); controller.abort(); source?.release(); };
    }, [uri, path, cloud, onError, forceRefresh, attempt]);
    if (!path && !cloud) return <>{children(uri, null)}</>;
    if (result?.uri === uri && result.attempt === attempt) return <>{children(result.source?.url ?? uri, result.source)}</>;
    const feedback = <div role="status" style={{ minHeight: waitingPreview ? undefined : 96, padding: 12, display: 'grid', placeContent: 'center', gap: 8, color: '#c9d4da', fontSize: theme.typography.small.fontSize,
        ...(waitingPreview ? { position: 'absolute' as const, bottom: 16, left: '50%', transform: 'translateX(-50%)', width: 'max-content', maxWidth: 'calc(100% - 32px)', borderRadius: 10, background: 'rgba(16,21,24,.9)' } : {}) }}>
        <span>{cloudStageLabel(stage)}</span>
        <progress aria-label="正在准备媒体文件" style={{ width: '100%', height: 4, accentColor: '#77cfc2' }} />
        {elapsedSeconds >= 15 ? <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
            <span style={{ fontSize: theme.typography.caption.fontSize, opacity: 0.8 }}>已等待 {elapsedSeconds} 秒</span>
            <button type="button" aria-label="重新确认媒体文件" onKeyDown={event => event.stopPropagation()} onKeyUp={event => event.stopPropagation()} onClick={event => { event.preventDefault(); event.stopPropagation(); setAttempt(value => value + 1); }}
                style={{ minHeight: 36, padding: '0 10px', border: '1px solid rgba(201,212,218,.28)', borderRadius: 7, background: 'transparent', color: 'inherit', font: 'inherit', fontSize: theme.typography.caption.fontSize, cursor: 'pointer' }}>重新确认</button>
        </div> : null}
    </div>;
    return <div ref={root} style={waitingPreview ? { position: 'relative', width: '100%', height: '100%' } : undefined}>{waitingPreview}{feedback}</div>;
}
