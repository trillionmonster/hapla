import * as React from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useSession } from '@/sync/storage';
import { apiSocket } from '@/sync/apiSocket';
import { layout } from './layout';
import { deliveryHints, deliveryLabels, type ComposerDelivery, type CodexFollowupControlsProps } from './codexFollowupModes';
import { useCodexFollowupStyle } from './codexFollowupStyle';
import './codexFollowups.css';

export { deliveryLabels } from './codexFollowupModes';
export type { ComposerDelivery } from './codexFollowupModes';
const modeIcons = { steer: 'chatbubble-outline', queue: 'layers-outline', btw: 'chatbubbles-outline', replace: 'stop-circle-outline' } as const;
type Popup = 'mode' | 'queue' | 'more' | null;

export function CodexFollowupControls(props: CodexFollowupControlsProps) {
    const style = useCodexFollowupStyle();
    const session = useSession(props.sessionId);
    const queue = session?.agentState?.codexInputs;
    const chats = session?.agentState?.codexSideChats ?? [];
    const runningSides = chats.filter(chat => chat.status === 'running' || chat.status === 'stopping').length;
    const root = React.useRef<HTMLDivElement>(null);
    const modeButton = React.useRef<HTMLButtonElement>(null);
    const [popup, setPopup] = React.useState<Popup>(null);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState('');
    const [edit, setEdit] = React.useState<{ id: string; revision: number; text: string } | null>(null);
    const count = queue?.items.length ?? 0;

    React.useLayoutEffect(() => {
        if (popup === 'mode' || popup === 'more') {
            const selected = root.current?.querySelector<HTMLElement>('[role="menu"] [aria-checked="true"]')
                ?? root.current?.querySelector<HTMLElement>('[role="menu"] button');
            selected?.focus();
        }
    }, [popup]);
    React.useEffect(() => {
        if (!popup) return;
        const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setPopup(null); };
        const escape = (event: KeyboardEvent) => {
            if (event.key !== 'Escape' || event.defaultPrevented) return;
            event.preventDefault(); event.stopImmediatePropagation(); setPopup(null); modeButton.current?.focus();
        };
        document.addEventListener('pointerdown', outside);
        document.addEventListener('keydown', escape, true);
        return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape, true); };
    }, [popup]);

    const action = async (method: string, params: unknown) => {
        setBusy(true); setError('');
        try { await apiSocket.sessionCommand(props.sessionId, method, params); setEdit(null); return true; }
        catch (problem) { setError(problem instanceof Error ? problem.message : '操作失败，请重试'); setPopup(method === 'codex-queue' ? 'queue' : null); return false; }
        finally { setBusy(false); }
    };
    const icon = (name: React.ComponentProps<typeof Ionicons>['name'], size = 16) => <Ionicons name={name} size={size} color="currentColor" aria-hidden />;
    const smallAction = (label: string, name: React.ComponentProps<typeof Ionicons>['name'], onClick: () => void, danger = false) =>
        <button type="button" className={`hapla-followup-icon${danger ? ' is-danger' : ''}`} aria-label={label} title={label} disabled={busy} onClick={onClick}>{icon(name)}</button>;
    const toggle = (next: Popup) => { setPopup(current => current === next ? null : next); setError(''); };
    const menuKeys = (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length]?.focus();
    };

    return <div ref={root} className={`hapla-followup-shell${props.embedded ? ' is-composer-inline' : ''}`} style={{ ...style, maxWidth: layout.maxWidth }}>
        <div className="hapla-followup-toolbar" aria-label="Codex 追问工具栏">
            <div className="hapla-followup-delivery">
                <button ref={modeButton} type="button" className={`hapla-followup-mode${props.mode === 'replace' ? ' is-danger' : ''}`} aria-label="选择发送方式" aria-haspopup="menu" aria-expanded={popup === 'mode'} title={deliveryHints[props.mode]} onClick={() => toggle('mode')} onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); setPopup('mode'); } }}>
                    {icon(modeIcons[props.mode])}<span>{props.embedded ? ({ steer: '追问', queue: '排队', btw: '旁问', replace: '替换' }[props.mode]) : deliveryLabels[props.mode]}</span>{icon('chevron-down', 12)}
                </button>
                <span className="hapla-followup-hint">{props.mode === 'btw' ? '发往独立旁聊' : props.mode === 'queue' ? '当前任务结束后处理' : props.mode === 'replace' ? '停止后开始新一轮' : 'Enter 发送 · Tab 排队'}</span>
            </div>
            <div className="hapla-followup-tools">
                <button type="button" className="hapla-followup-tool" aria-label="查看待发送队列" aria-expanded={popup === 'queue'} onClick={() => toggle('queue')}>
                    {icon('layers-outline')}<span>队列</span>{count > 0 && <span className="hapla-followup-count">{count}</span>}{queue?.paused && <span className="hapla-followup-paused" aria-label="队列已暂停" />}
                </button>
                <button type="button" className={`hapla-followup-tool${props.sidePanelOpen ? ' is-active' : ''}`} aria-label="打开旁问侧栏" aria-pressed={props.sidePanelOpen} onClick={() => props.onSidePanel?.()}>
                    {icon('chatbubbles-outline')}<span>旁问</span>{runningSides > 0 && <span className="hapla-followup-live" aria-label="旁问正在回答" />}
                </button>
                <button type="button" className="hapla-followup-icon hapla-followup-more-trigger" aria-label="更多会话操作" aria-haspopup="menu" aria-expanded={popup === 'more'} onClick={() => toggle('more')}>{icon('ellipsis-horizontal')}</button>
            </div>
        </div>

        {popup === 'mode' && <div className="hapla-followup-menu hapla-followup-mode-menu" role="menu" aria-label="发送方式" onKeyDown={menuKeys}>
            {(['steer', 'queue', 'btw', 'replace'] as const).map(mode => <button key={mode} type="button" role="menuitemradio" aria-checked={props.mode === mode} aria-label={deliveryLabels[mode]} className={`hapla-followup-option${mode === 'replace' ? ' is-danger has-divider' : ''}`} onClick={() => { props.onMode(mode); setPopup(null); modeButton.current?.focus(); }}>
                {icon(modeIcons[mode], 18)}<span><strong>{deliveryLabels[mode]}</strong><small>{deliveryHints[mode]}</small></span>{props.mode === mode && icon('checkmark')}
            </button>)}
        </div>}
        {popup === 'more' && <div className="hapla-followup-menu hapla-followup-more-menu" role="menu" aria-label="更多会话操作" onKeyDown={menuKeys}>
            <button type="button" role="menuitem" aria-label="新分支" className="hapla-followup-option" disabled={busy} onClick={() => { setPopup(null); modeButton.current?.focus(); void action('codex-thread-fork-current', {}); }}>
                {icon('git-branch-outline', 18)}<span><strong>新分支</strong><small>保留当前任务，创建独立分支</small></span>
            </button>
        </div>}
        {popup === 'queue' && <section className="hapla-followup-queue" aria-label="待发送队列">
            <header><div><strong>待发送</strong><span>{count} 条{queue?.paused ? ' · 已暂停' : ''}</span></div><div className="hapla-followup-tools">
                <button type="button" className="hapla-followup-text-action" disabled={busy} onClick={() => void action('codex-queue', { action: queue?.paused ? 'start' : 'pause' })}>{icon(queue?.paused ? 'play-outline' : 'pause-outline', 14)}{queue?.paused ? '继续队列' : '暂停队列'}</button>
                {smallAction('收起队列', 'close', () => setPopup(null))}
            </div></header>
            {!!error && <div className="hapla-followup-error" role="alert">{error}</div>}
            <div className="hapla-followup-queue-list">
                {!count && <div className="hapla-followup-empty">没有待发送的消息<span>在输入框按 Tab，或选择“排队下一轮”。</span></div>}
                {queue?.items.map((item, index) => <div key={item.id} className="hapla-followup-queue-row">
                    <span className="hapla-followup-order">{String(index + 1).padStart(2, '0')}</span>
                    <div className="hapla-followup-queue-copy">
                        {edit?.id === item.id ? <><textarea aria-label="编辑排队消息" autoFocus value={edit.text} onChange={event => setEdit({ ...edit, text: event.target.value })} rows={3} /><div className="hapla-followup-edit-actions"><button type="button" disabled={busy} onClick={() => void action('codex-queue', { action: 'update', id: item.id, revision: edit.revision, text: edit.text })}>保存</button><button type="button" onClick={() => setEdit(null)}>取消</button></div></> : <p>{item.message}</p>}
                        {item.error && <div className="hapla-followup-error">{item.error}</div>}
                    </div>
                    <div className="hapla-followup-row-actions">
                        {smallAction('修改', 'create-outline', () => setEdit({ id: item.id, revision: item.revision, text: item.message }))}
                        {index > 0 && smallAction('上移', 'arrow-up', () => { const ids = queue.items.map(entry => entry.id); [ids[index - 1], ids[index]] = [ids[index], ids[index - 1]]; void action('codex-queue', { action: 'reorder', ids }); })}
                        {smallAction('立即发送', 'arrow-forward', () => void action('codex-queue', { action: 'inject', id: item.id, revision: item.revision }))}
                        {smallAction('删除', 'trash-outline', () => void action('codex-queue', { action: 'remove', id: item.id, revision: item.revision }), true)}
                    </div>
                </div>)}
            </div>
        </section>}
        {!!error && popup !== 'queue' && <div className="hapla-followup-error" role="alert">{error}</div>}
    </div>;
}
