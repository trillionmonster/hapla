import * as React from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useSession } from '@/sync/storage';
import { apiSocket } from '@/sync/apiSocket';
import { MarkdownView } from './markdown/MarkdownView';
import type { CodexSideChatPanelProps } from './CodexSideChatPanel';
import { useCodexFollowupStyle } from './codexFollowupStyle';
import './codexFollowups.css';

export function CodexSideChatPanel(props: CodexSideChatPanelProps) {
    const style = useCodexFollowupStyle();
    const session = useSession(props.sessionId);
    const chats = session?.agentState?.codexSideChats ?? [];
    const selected = chats.find(chat => chat.id === props.selectedId);
    const panel = React.useRef<HTMLElement>(null);
    const scroller = React.useRef<HTMLDivElement>(null);
    const following = React.useRef(true);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState('');
    React.useLayoutEffect(() => {
        const composer = document.getElementById(`hapla-composer-${props.sessionId}`);
        const parent = panel.current?.parentElement;
        if (!composer || !parent) return;
        const place = () => {
            if (!panel.current) return;
            const bounds = parent.getBoundingClientRect();
            const input = composer.getBoundingClientRect();
            panel.current.style.setProperty('--btw-composer-space', `${Math.max(120, bounds.bottom - input.top + 8)}px`);
            panel.current.dataset.compact = String(input.top - bounds.top - 12 <= 140);
        };
        place();
        const observer = new ResizeObserver(place);
        observer.observe(composer); observer.observe(parent);
        return () => observer.disconnect();
    }, [props.sessionId]);
    React.useEffect(() => { following.current = true; setError(''); }, [props.selectedId]);
    React.useLayoutEffect(() => { if (following.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; }, [selected?.messages]);
    React.useEffect(() => {
        const escape = (event: KeyboardEvent) => {
            if (event.key === 'Escape' && !event.defaultPrevented && !document.querySelector('.hapla-followup-menu, .hapla-followup-queue, .hapla-mobile-composer-menu, [aria-label="会话设置面板"], [aria-label="历史问题面板"]')) { event.preventDefault(); event.stopImmediatePropagation(); props.onClose(); }
        };
        document.addEventListener('keydown', escape, true);
        return () => document.removeEventListener('keydown', escape, true);
    }, [props.onClose]);
    const action = async (operation: 'stop' | 'remove') => {
        if (!selected) return;
        setBusy(true); setError('');
        try { await apiSocket.sessionCommand(props.sessionId, 'codex-side-action', { action: operation, id: selected.id }); if (operation === 'remove') props.onSelect(undefined); }
        catch (problem) { setError(problem instanceof Error ? problem.message : '操作失败，请重试'); }
        finally { setBusy(false); }
    };
    const active = selected?.status === 'running' || selected?.status === 'stopping';
    return <aside ref={panel} className="hapla-btw-panel" style={style} aria-label="旁问侧栏">
        <div className="hapla-btw-top">
        <header className="hapla-btw-header"><div className="hapla-btw-heading"><h2>旁问 <span>BTW</span></h2></div><div className="hapla-followup-tools"><button type="button" className="hapla-followup-icon" aria-label="新旁问" title="新旁问" onClick={() => { props.onSelect(undefined); props.onCompose(); }}><Ionicons name="add" size={19} color="currentColor" /></button>{active && <button type="button" className="hapla-followup-text-action hapla-btw-compact-stop is-danger" aria-label="停止旁问" disabled={busy} onClick={() => void action('stop')}>停止旁问</button>}<button type="button" className="hapla-followup-icon" aria-label="收起旁问" title="收起旁问" onClick={props.onClose}><Ionicons name="close" size={18} color="currentColor" /></button></div></header>
        <div className="hapla-btw-context">独立回答，主任务继续运行</div>
        <div className="hapla-btw-picker"><span className="hapla-btw-picker-label" aria-hidden="true">{selected?.title || '新旁问'}</span><select aria-label="选择旁聊" value={selected?.id ?? ''} onChange={event => { props.onSelect(event.target.value || undefined); props.onCompose(); }}><option value="">新旁问</option>{chats.map(chat => <option key={chat.id} value={chat.id}>{chat.title}</option>)}</select></div>
        </div>
        <div ref={scroller} className="hapla-btw-messages" onScroll={() => { const element = scroller.current; if (element) following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48; }}>
            {!selected && <div className="hapla-btw-empty"><Ionicons name="chatbubbles-outline" size={28} color="currentColor" /><h3>发起一个旁问</h3><p>在下方输入框发送消息，回答会显示在这里。</p><span>旁聊默认只读</span></div>}
            {selected?.messages.map(message => <div key={message.id} className={`hapla-btw-message is-${message.role}`}><span className="hapla-btw-author">{message.role === 'user' ? '你' : 'Codex'}</span>{message.role === 'assistant' ? <MarkdownView markdown={message.text} sessionId={props.sessionId} /> : <div className="hapla-btw-user-text">{message.text}</div>}</div>)}
            {active && <div className="hapla-btw-status" role="status"><span className="hapla-followup-live" />{selected?.status === 'stopping' ? '正在停止旁问…' : '正在回答…'}</div>}
            {(error || selected?.error) && <div className="hapla-followup-error" role="alert">{error || selected?.error}</div>}
        </div>
        <footer className="hapla-btw-footer"><button type="button" className="hapla-btw-compose" aria-label={props.composing ? '在下方输入框继续旁问' : '继续这个旁问'} onClick={props.onCompose}>{props.composing ? '在输入框继续' : '继续旁问'}<Ionicons name="arrow-down-outline" size={15} color="currentColor" /></button><div><span>只读旁聊 · 独立上下文</span><div className="hapla-followup-tools">{active && <button type="button" className="hapla-followup-text-action hapla-btw-footer-stop is-danger" disabled={busy} onClick={() => void action('stop')}>停止旁问</button>}{selected && <button type="button" className="hapla-followup-icon" title="关闭旁聊" aria-label="关闭旁聊" disabled={busy} onClick={() => void action('remove')}><Ionicons name="trash-outline" size={15} color="currentColor" /></button>}</div></div></footer>
    </aside>;
}
