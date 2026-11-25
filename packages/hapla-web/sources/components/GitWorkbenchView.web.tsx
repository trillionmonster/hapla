import React from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useWindowDimensions } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';
import { useSession } from '@/sync/storage';
import { gitWorkbenchRpc } from '@/sync/gitWorkbench';
import { apiSocket } from '@/sync/apiSocket';
import { getCurrentLanguage } from '@/text';
import { gitWorkbenchEnglish } from '@/text/gitWorkbenchLabels';
import { gitWorkbenchChinese } from '@/text/gitWorkbenchLabels.zh';
import { getMonoFont } from '@/constants/Typography';
import { useWorkspaceControlStyle } from './WorkspaceControl.web';
import { GitWorkbenchDiff } from './GitWorkbenchDiff.web';
import { parseReviewPatch } from './gitWorkbenchDiff';
import type { GitSource, GitWorkbenchRequest, GitWorkbenchResponse, GitChangedFile } from '@hapla/wire';
import './gitWorkbench.css';

type IconName = React.ComponentProps<typeof Ionicons>['name'];
const Icon = ({ name, size = 16 }: { name: IconName; size?: number }) => <Ionicons name={name} size={size} color="currentColor" aria-hidden={true} />;

export default function GitWorkbenchView({ sessionId }: { sessionId: string }) {
    const language = getCurrentLanguage();
    const labels = language.startsWith('zh') ? gitWorkbenchChinese : gitWorkbenchEnglish;
    const session = useSession(sessionId); const router = useRouter(); const workspaceStyle = useWorkspaceControlStyle();
    const { theme } = useUnistyles(); const compact = useWindowDimensions().width <= 1100;
    const directory = session?.metadata?.path; const machineId = session?.metadata?.machineId;
    const style = { ...workspaceStyle,
        '--git-mono': getMonoFont(), '--git-accent': theme.colors.gitAddedText,
        '--git-danger': theme.colors.gitRemovedText,
        '--git-chrome': theme.dark ? '#202224' : '#f7f8f9',
        '--git-panel': theme.dark ? '#191b1d' : '#fff',
        '--git-hover': theme.dark ? '#282c2e' : '#eef1f3',
        '--git-selected': theme.dark ? '#18362c' : '#e9f4ee',
        '--git-added-bg': theme.dark ? '#183127' : '#eaf7ee',
        '--git-removed-bg': theme.dark ? '#3b2225' : '#fff0ee',
        '--git-hunk-bg': theme.dark ? '#232d37' : '#eef3f8',
        '--git-primary': theme.dark ? '#82d8af' : '#176b4c',
        '--git-primary-text': theme.dark ? '#10291e' : '#fff',
    } as React.CSSProperties;
    const [summary, setSummary] = React.useState<GitWorkbenchResponse>({});
    const [commits, setCommits] = React.useState<NonNullable<GitWorkbenchResponse['commits']>>([]);
    const [checkpoints, setCheckpoints] = React.useState<NonNullable<GitWorkbenchResponse['checkpoints']>>([]);
    const [source, setSource] = React.useState<GitSource>('working'); const [path, setPath] = React.useState('');
    const [ref, setRef] = React.useState('HEAD'); const [checkpointId, setCheckpointId] = React.useState(''); const [base, setBase] = React.useState('');
    const [diffPending, setDiffPending] = React.useState(false);
    const [diff, setDiff] = React.useState<GitWorkbenchResponse | null>(null);
    const [message, setMessage] = React.useState(''); const [title, setTitle] = React.useState(''); const [body, setBody] = React.useState('');
    const [pr, setPr] = React.useState<GitWorkbenchResponse['pr']>(); const [feedback, setFeedback] = React.useState('');
    const [error, setError] = React.useState(''); const [busy, setBusy] = React.useState(false); const generation = React.useRef(0);
    const [refreshKey, setRefreshKey] = React.useState(0);
    const [filter, setFilter] = React.useState(''); const [filesOpen, setFilesOpen] = React.useState(!compact); const [raw, setRaw] = React.useState(false);
    const mounted = React.useRef(true); React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
    const rpc = React.useCallback((request: GitWorkbenchRequest) => {
        if (!directory || (!session?.active && !machineId)) return Promise.reject(new Error('Workspace is unavailable.'));
        return gitWorkbenchRpc(sessionId, machineId, session?.active === true, { directory, sessionId: session?.metadata?.conversationRootSessionId ?? sessionId, ...request });
    }, [sessionId, machineId, session?.active, directory, session?.metadata?.conversationRootSessionId]);
    const load = React.useCallback(async () => {
        const [status, history, saved] = await Promise.all([rpc({ operation: 'status' }), rpc({ operation: 'log' }), rpc({ operation: 'checkpoints' })]);
        if (!mounted.current) return;
        setSummary(status); setCommits(history.commits ?? []); setCheckpoints(saved.checkpoints ?? []);
    }, [rpc]);
    React.useEffect(() => { setError(''); void load().catch(e => { if (mounted.current) setError(e.message); }); }, [load]);
    React.useEffect(() => {
        let initial = true;
        const unsubscribe = apiSocket.onStatusChange(status => {
            if (!initial && status === 'connected') void load().then(() => {
                if (mounted.current) { setError(''); setRefreshKey(value => value + 1); }
            }).catch(problem => { if (mounted.current) setError(problem.message); });
            initial = false;
        });
        return () => { unsubscribe(); };
    }, [load]);
    const query: GitWorkbenchRequest = { operation: 'diff', source, ...(path ? { path } : {}), ref, checkpointId: checkpointId || undefined, base: base || undefined };
    const queryKey = JSON.stringify(query);
    React.useEffect(() => {
        const version = ++generation.current; setDiff(null); setError(''); setDiffPending(true);
        if (source === 'turn' && !checkpointId) { setDiffPending(false); return; }
        void rpc(query).then(result => { if (version === generation.current) { setDiff(result); setDiffPending(false); } }).catch(e => { if (version === generation.current) { setError(e.message); setDiffPending(false); } });
        return () => { generation.current++; };
    }, [rpc, queryKey, summary.revision, refreshKey]);
    const run = async (action: () => Promise<unknown>, options: { reloadDiff?: boolean; refreshStatus?: boolean } = {}) => {
        if (busy) return;
        setBusy(true); setError(''); setFeedback('');
        if (options.reloadDiff) { setDiff(null); setDiffPending(true); }
        try {
            await action();
            if (options.refreshStatus !== false) await load();
            if (options.reloadDiff) setRefreshKey(value => value + 1);
        }
        catch (problem) { setError(problem instanceof Error ? problem.message : String(problem)); if (options.reloadDiff) setDiffPending(false); }
        finally { if (mounted.current) setBusy(false); }
    };
    const mutate = (request: GitWorkbenchRequest) => run(async () => { const result = await rpc({ ...request, expectedRevision: summary.revision }); setFeedback(result.message ?? labels.saved); });
    const historical = source === 'branch' || source === 'commit' || source === 'turn';
    const listedFiles = historical ? diff?.files : summary.files;
    const visibleFiles = (listedFiles ?? []).filter(file => file.path.toLowerCase().includes(filter.toLowerCase()));
    const stagedCount = (summary.files ?? []).filter(file => file.index !== ' ' && file.index !== '?').length;
    const selectedCheckpoint = checkpoints.find(item => item.id === checkpointId);
    const stats = React.useMemo(() => parseReviewPatch(diff?.text ?? ''), [diff?.text]);
    const restore = () => run(async () => {
        if (!selectedCheckpoint || !summary.revision || !window.confirm(labels.restoreConfirm)) return;
        const result = await apiSocket.sessionCommand<{ message: string }, { id: string; revision: string }>(sessionId, 'git-checkpoint-restore', { id: selectedCheckpoint.id, revision: summary.revision }, 150_000);
        setFeedback(result.message);
    });
    const restoreEnabled = summary.isWorktree && session?.metadata?.flavor === 'codex' && session.active && !!selectedCheckpoint?.threadId && selectedCheckpoint.threadId === session.metadata.codexThreadId;
    const selectSource = (value: GitSource) => { setSource(value); setPath(''); if (value === 'turn') setFilesOpen(true); };
    const fileStatus = (file: GitChangedFile) => {
        const code = file.index === '?' || file.working === 'A' || file.index === 'A' ? 'A' : file.working === 'D' || file.index === 'D' ? 'D' : file.originalPath ? 'R' : 'M';
        return { code, title: code === 'A' ? labels.fileAdded : code === 'D' ? labels.fileDeleted : code === 'R' ? labels.fileRenamed : labels.fileModified };
    };
    const statusLabel = (status: string) => ({ complete: labels.statusComplete, pending: labels.statusPending, failed: labels.statusFailed, interrupted: labels.statusInterrupted, manual: labels.statusManual }[status] ?? status);
    const formatTime = (timestamp: number) => new Intl.DateTimeFormat(language, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(timestamp);
    const repositoryName = directory?.split('/.dev/worktree/')[0].split('/').filter(Boolean).at(-1) ?? labels.title;
    const diffFailed = !diffPending && !!error && diff === null;
    const diffLabel = path ? path.split('/').at(-1)! : labels.allFiles;
    return <main className="hapla-git" style={style} aria-label={labels.review}>
        <header className="hapla-git-header">
            <button className="hapla-git-icon-button" type="button" onClick={() => router.push(`/session/${sessionId}`)} aria-label={labels.back} title={labels.back}><Icon name="arrow-back-outline" size={19} /></button>
            <div className="hapla-git-heading"><h1>{labels.title}</h1><span className="hapla-git-repository" title={directory}>{repositoryName}</span></div>
            <span className="hapla-git-branch" title={summary.branch}><Icon name="git-branch-outline" size={14} /><span>{summary.branch || '…'}</span></span>
            <div className="hapla-git-header-actions">
                <button className="hapla-git-button hapla-git-button--quiet" type="button" disabled={busy} aria-label={labels.refresh} onClick={() => void run(async () => {}, { reloadDiff: true })}><span className={busy ? 'hapla-git-spinning' : ''}><Icon name="refresh-outline" /></span><span>{labels.refresh}</span></button>
                <button className="hapla-git-button" type="button" disabled={busy} aria-label={labels.push} onClick={() => { if (window.confirm(labels.pushConfirm)) void mutate({ operation: 'push' }); }}><Icon name="cloud-upload-outline" /><span>{labels.push}</span></button>
            </div>
        </header>
        <div className="hapla-git-source" role="group" aria-label={labels.diff}>
            {(['working', 'staged', 'branch', 'commit', 'turn'] as const).map(value => <button type="button" key={value} aria-pressed={source === value} onClick={() => selectSource(value)}>
                <Icon name={value === 'working' ? 'git-compare-outline' : value === 'staged' ? 'checkmark-circle-outline' : value === 'branch' ? 'git-branch-outline' : value === 'commit' ? 'git-commit-outline' : 'time-outline'} size={15} />
                <span>{labels[value]}</span>{value === 'staged' && stagedCount > 0 && <span className="hapla-git-count">{stagedCount}</span>}
            </button>)}
        </div>
        {(error || feedback) && <div className={`hapla-git-notice ${error ? 'hapla-git-error' : 'hapla-git-feedback'}`} role={error ? 'alert' : 'status'}>
            <Icon name={error ? 'alert-circle-outline' : 'checkmark-circle-outline'} /><span>{error || feedback}</span>
            {error && <button type="button" className="hapla-git-button hapla-git-button--quiet" disabled={busy} onClick={() => void run(async () => {}, { reloadDiff: true })}>{labels.retry}</button>}
        </div>}
        <div className="hapla-git-layout">
            <aside className="hapla-git-sidebar">
                <h2 className="hapla-git-panel-heading">
                    <button type="button" className="hapla-git-files-toggle" aria-expanded={filesOpen} aria-controls="hapla-git-file-list" onClick={() => setFilesOpen(value => !value)}>
                        <Icon name="folder-open-outline" /><span className="hapla-git-files-title">{labels.files}</span><span className="hapla-git-count">{listedFiles?.length ?? 0}</span>{<Icon name={filesOpen ? 'chevron-up-outline' : 'chevron-down-outline'} size={14} />}
                    </button>
                </h2>
                <div className="hapla-git-sidebar-body" id="hapla-git-file-list" hidden={!filesOpen}>
                    <label className="hapla-git-filter"><Icon name="search-outline" size={14} /><input aria-label={labels.filter} placeholder={labels.filter} value={filter} onChange={event => setFilter(event.target.value)} /></label>
                    <div className="hapla-git-file-list">
                        <button type="button" className="hapla-git-all-files" aria-pressed={!path} onClick={() => { setPath(''); setFilesOpen(!compact); }}><Icon name="layers-outline" size={15} /><span>{labels.allFiles}</span><span className="hapla-git-count">{listedFiles?.length ?? 0}</span></button>
                        {visibleFiles.length === 0 && <p className="hapla-git-sidebar-empty">{filter ? labels.noMatches : labels.noFiles}</p>}
                        {visibleFiles.map(file => { const status = fileStatus(file); const parts = file.path.split('/'); const name = parts.pop()!;
                            return <div className="hapla-git-file" key={file.path} data-selected={path === file.path}>
                                <button type="button" className="hapla-git-file-select" title={file.path} aria-pressed={path === file.path} onClick={() => { setPath(file.path); setFilesOpen(!compact); if (!historical) setSource(file.index !== ' ' && file.index !== '?' ? 'staged' : 'working'); }}>
                                    <Icon name="document-text-outline" size={15} /><span className="hapla-git-file-name"><span>{name}</span>{parts.length > 0 && <small>{parts.join('/')}</small>}</span>
                                    <span className={`hapla-git-file-status hapla-git-file-status--${status.code}`} title={status.title}>{status.code}</span>
                                </button>
                                {!historical && file.working !== ' ' && <button className="hapla-git-icon-button hapla-git-file-action" type="button" disabled={busy} aria-label={`${labels.stage} ${file.path}`} title={labels.stage} onClick={() => void mutate({ operation: 'stage', path: file.path })}><Icon name="add-outline" size={17} /></button>}
                                {!historical && file.index !== ' ' && file.index !== '?' && <button className="hapla-git-icon-button hapla-git-file-action" type="button" disabled={busy} aria-label={`${labels.unstage} ${file.path}`} title={labels.unstage} onClick={() => void mutate({ operation: 'unstage', path: file.path })}><Icon name="remove-outline" size={17} /></button>}
                            </div>;
                        })}
                    </div>
                    <details className="hapla-git-checkpoints" open={source === 'turn'}>
                        <summary><Icon name="time-outline" size={15} /><span>{labels.checkpoints}</span><span className="hapla-git-count">{checkpoints.length}</span><Icon name="chevron-down-outline" size={12} /></summary>
                        <div className="hapla-git-checkpoint-list">
                            <button type="button" className="hapla-git-button hapla-git-button--quiet hapla-git-save-checkpoint" disabled={busy || !session?.active || session.metadata?.flavor !== 'codex'} onClick={() => void run(async () => { await apiSocket.sessionCommand(sessionId, 'git-checkpoint-create', {}); })}><Icon name="add-outline" size={14} />{labels.checkpointCreate}</button>
                            {checkpoints.length === 0 && <p className="hapla-git-sidebar-empty">{labels.noCheckpoints}</p>}
                            {checkpoints.slice().reverse().map(item => <button className="hapla-git-checkpoint" type="button" key={item.id} aria-pressed={checkpointId === item.id && source === 'turn'} onClick={() => { setCheckpointId(item.id); setSource('turn'); setPath(''); setFilesOpen(!compact); }}>
                                <span className={`hapla-git-checkpoint-dot hapla-git-checkpoint-dot--${item.status}`} /><span><strong>{item.label}</strong><small>{formatTime(item.createdAt)}<span>{statusLabel(item.status)}</span></small></span>
                            </button>)}
                        </div>
                    </details>
                </div>
            </aside>
            <section className="hapla-git-review">
                {source === 'branch' && <label className="hapla-git-revision-control"><Icon name="git-branch-outline" /><span>{labels.base}</span><input aria-label={labels.base} placeholder="main" value={base} onChange={event => setBase(event.target.value)} /></label>}
                {source === 'commit' && <label className="hapla-git-revision-control"><Icon name="git-commit-outline" /><span>{labels.commit}</span><select aria-label={labels.commit} value={ref === 'HEAD' ? commits[0]?.id ?? 'HEAD' : ref} onChange={event => setRef(event.target.value)}>{commits.map(item => <option key={item.id} value={item.id}>{item.id.slice(0, 8)} {item.subject}</option>)}</select></label>}
                {source === 'turn' && selectedCheckpoint && <div className="hapla-git-restore-bar"><Icon name="time-outline" /><span><strong>{selectedCheckpoint.label}</strong><small>{formatTime(selectedCheckpoint.createdAt)}</small></span><button className="hapla-git-button hapla-git-button--danger" type="button" title={!restoreEnabled ? labels.restoreUnavailable : undefined} disabled={busy || !restoreEnabled} onClick={() => void restore()}><Icon name="return-up-back-outline" size={14} />{labels.restore}</button></div>}
                <div className="hapla-git-diff-heading"><Icon name="git-compare-outline" /><strong title={path || undefined}>{diffLabel}</strong><span className="hapla-git-diff-stats" aria-label={`${stats.added} ${labels.fileAdded}, ${stats.removed} ${labels.fileDeleted}`}><span>+{stats.added}</span><span>−{stats.removed}</span></span>
                    <button type="button" className="hapla-git-icon-button" aria-label={raw ? labels.formatted : labels.raw} title={raw ? labels.formatted : labels.raw} aria-pressed={raw} onClick={() => setRaw(value => !value)}><Icon name={raw ? 'list-outline' : 'code-slash-outline'} /></button>
                </div>
                {diffPending ? <div className="hapla-git-diff-skeleton" role="status" aria-label={labels.busy}>{[72, 48, 63, 38, 57, 45].map((width, i) => <span key={i} style={{ width: `${width}%` }} />)}</div> : diff?.text ? <GitWorkbenchDiff text={diff.text} patch={stats} label={labels.diff} raw={raw} /> : <div className="hapla-git-empty"><span className="hapla-git-empty-icon"><Icon name={diffFailed ? 'alert-circle-outline' : source === 'turn' && !checkpointId ? 'time-outline' : 'checkmark-done-outline'} size={26} /></span><h3>{diffFailed ? labels.errorTitle : labels.cleanTitle}</h3><p>{diffFailed ? labels.errorHint : source === 'turn' && !checkpointId ? labels.chooseTurn : labels.cleanHint}</p></div>}
                <div className="hapla-git-diff-footer"><span>{diffPending ? labels.busy : `${listedFiles?.length ?? 0} ${labels.filesChanged}`}</span><span>{diff?.nextOffset != null ? `${new TextEncoder().encode(diff.text ?? '').length.toLocaleString()} / ${diff.totalBytes?.toLocaleString()} B ${labels.loaded}` : diff ? `${(diff.totalBytes ?? 0).toLocaleString()} B` : ''}</span>
                    {diff?.nextOffset != null && <button type="button" className="hapla-git-button hapla-git-button--quiet" disabled={busy} onClick={() => void run(async () => {
                        const version = generation.current; const next = await rpc({ ...query, offset: diff.nextOffset!, expectedRevision: diff.revision });
                        if (version === generation.current) setDiff({ ...next, text: (diff.text ?? '') + (next.text ?? '') });
                    }, { refreshStatus: false })}>{labels.more}<Icon name="chevron-down-outline" size={13} /></button>}
                </div>
            </section>
            <section className="hapla-git-delivery" aria-label={labels.delivery}>
                <form className="hapla-git-commit-form" onSubmit={event => { event.preventDefault(); void run(async () => { await rpc({ operation: 'commit', message, expectedRevision: summary.revision }); setMessage(''); setFeedback(labels.saved); }); }}>
                    <label htmlFor="hapla-git-commit-message">{labels.commitMessage}<span>{stagedCount} {labels.stagedFiles}</span></label>
                    <textarea id="hapla-git-commit-message" aria-label={labels.commitMessage} placeholder={labels.commitPlaceholder} value={message} onChange={event => setMessage(event.target.value)} required />
                    <button type="submit" className="hapla-git-button hapla-git-button--primary" disabled={busy || !message.trim()}><Icon name="git-commit-outline" />{labels.commitAction}</button>
                    {stagedCount === 0 && <p className="hapla-git-form-hint">{labels.stagedHint}</p>}
                </form>
                <details className="hapla-git-pr"><summary><Icon name="git-pull-request-outline" /><span>{labels.prCreate}</span><Icon name="chevron-down-outline" size={13} /></summary>
                    <p className="hapla-git-form-hint">{labels.prHint}</p>
                    <form className="hapla-git-pr-form" onSubmit={event => { event.preventDefault(); if (window.confirm(labels.prConfirm)) void run(async () => { const result = await rpc({ operation: 'pr-create', title, body }); setPr(result.pr); setTitle(''); setBody(''); setFeedback(result.message ?? ''); }); }}>
                        <label>{labels.prTitle}<input aria-label={labels.prTitle} value={title} onChange={event => setTitle(event.target.value)} required /></label>
                        <label>{labels.prBody}<textarea aria-label={labels.prBody} value={body} onChange={event => setBody(event.target.value)} /></label>
                        <button type="submit" className="hapla-git-button" disabled={busy || !title.trim()}>{labels.prCreate}<Icon name="arrow-up-outline" size={14} /></button>
                    </form>
                </details>
                <button type="button" className="hapla-git-button hapla-git-button--quiet hapla-git-pr-status" disabled={busy} onClick={() => void run(async () => { setPr((await rpc({ operation: 'pr-status' })).pr); })}><Icon name="checkmark-circle-outline" size={15} />{labels.prStatus}</button>
                {pr?.url && <a className="hapla-git-pr-link" href={pr.url} target="_blank" rel="noreferrer"><Icon name="git-pull-request-outline" size={14} /><span>{pr.url} {pr.state}</span><Icon name="open-outline" size={13} /></a>}
                {pr?.checks?.map((check, i) => <p className="hapla-git-check-result" key={i}><Icon name={check.conclusion === 'SUCCESS' ? 'checkmark-circle-outline' : 'ellipse-outline'} size={14} /><span>{check.name}: {check.conclusion || check.status}</span></p>)}
            </section>
        </div>
    </main>;
}
