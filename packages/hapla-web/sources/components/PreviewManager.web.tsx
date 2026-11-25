import * as React from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useUnistyles } from 'react-native-unistyles';
import { useAllMachines } from '@/sync/storage';
import { apiSocket } from '@/sync/apiSocket';
import { isMachineOnline } from '@/utils/machineUtils';
import { Modal } from '@/modal';
import { useAuth } from '@/auth/AuthContext';
import { validatePreviewTarget, type PreviewAccess, type PreviewRegistration } from '@hapla/wire';
import { previewLink } from './previewLinks';
import { emptyPreviewRule as empty, previewEditorFor } from './previewEditor';
import './previewManager.css';

const accessLabels: Record<PreviewAccess, string> = { private: '仅自己', users: 'Hapla 全部用户', key: '公网凭密钥' };
export function PreviewManager() {
    const { theme } = useUnistyles();
    const machines = useAllMachines({ includeOffline: true });
    const { credentials } = useAuth();
    const useEditor = React.useMemo(() => previewEditorFor(credentials?.token ?? ''), [credentials?.token]);
    const { items, setItems, editing, setEditing, draft, setDraft, busy, setBusy } = useEditor();
    const [loading, setLoading] = React.useState(true);
    const [sharing, setSharing] = React.useState(false);
    const [error, setError] = React.useState('');
    const [notice, setNotice] = React.useState('');
    const [filter, setFilter] = React.useState<'all' | 'mine' | 'shared'>('all');
    const [query, setQuery] = React.useState('');
    const [showSecret, setShowSecret] = React.useState(false);
    const [secret, setSecret] = React.useState<{ handle: string; key: string } | null>(null);
    const editor = React.useRef<HTMLFormElement>(null);
    const alert = React.useRef<HTMLDivElement>(null);
    React.useEffect(() => { if (error) alert.current?.scrollIntoView({ block: 'nearest' }); }, [error]);
    const update = (registration: PreviewRegistration) => {
        setItems(previous => [{ ...registration, canManage: true }, ...previous.filter(item => item.handle !== registration.handle)]);
        setEditing(registration);
    };
    const load = React.useCallback(async () => {
        setLoading(true); setError('');
        try {
            const response = await apiSocket.request('/v1/previews?scope=visible');
            if (!response.ok) throw new Error('代理列表加载失败，请重试');
            const data = await response.json(); setItems(data.registrations); setSharing(data.sharingConfigured);
        } catch (problem) { setError(problem instanceof Error ? problem.message : '加载失败'); }
        finally { setLoading(false); }
    }, []);
    React.useEffect(() => { void load(); }, [load]);
    React.useEffect(() => { if (editing !== undefined) editor.current?.querySelector<HTMLInputElement>('input')?.focus(); }, [editing?.handle, editing === null]);
    const edit = (item?: PreviewRegistration) => {
        setError(''); setNotice(''); setSecret(null); setShowSecret(false); setEditing(item ?? null);
        setDraft(item ? { name: item.name, target: item.target, machineId: item.machineId, access: item.access ?? 'private' } : { ...empty, machineId: machines.find(isMachineOnline)?.id ?? machines[0]?.id ?? '' });
    };
    const save = async (event: React.FormEvent) => {
        event.preventDefault(); if (busy) return; setBusy(true); setError(''); setNotice('');
        try {
            const target = validatePreviewTarget(draft.target.trim());
            const response = await apiSocket.request('/v1/previews', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...draft, name: draft.name.trim(), target, handle: editing?.handle, revision: editing?.revision }) });
            const data = await response.json(); if (!response.ok) throw new Error(data.error || '保存失败');
            update(data); setSecret(null); setNotice('已保存。修改目标后，原入口继续生效。');
        } catch (problem) { setError(problem instanceof Error ? problem.message : '保存失败'); }
        finally { setBusy(false); }
    };
    const key = async (operation: 'rotate' | 'revoke') => {
        if (!editing || busy) return;
        if (editing.hasShareKey && !await Modal.confirm(operation === 'rotate' ? '重新生成共享密钥？' : '撤销共享密钥？', '现有密钥和已授权的公网访问将立即失效。')) return;
        setBusy(true); setError(''); setNotice('');
        try {
            const response = await apiSocket.request(`/v1/previews/${editing.handle}/share-key`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: editing.revision, operation }) });
            const data = await response.json(); if (!response.ok) throw new Error(data.error || '密钥更新失败');
            update(data.registration); setShowSecret(false); setSecret(data.key ? { handle: editing.handle, key: data.key } : null);
            setNotice(data.key ? '密钥仅在此次显示，请复制保存。' : '已撤销密钥，公网访问已关闭。');
        } catch (problem) { setError(problem instanceof Error ? problem.message : '密钥更新失败'); }
        finally { setBusy(false); }
    };
    const remove = async () => {
        if (!editing || busy || !await Modal.confirm('删除此代理？', '固定入口和共享访问将立即失效。目标服务本身不受影响。')) return;
        setBusy(true); setError('');
        try {
            const response = await apiSocket.request(`/v1/previews/${editing.handle}`, { method: 'DELETE' });
            if (!response.ok) throw new Error('删除失败，请重试');
            setItems(previous => previous.filter(item => item.handle !== editing.handle)); setEditing(undefined); setSecret(null); setNotice('代理已删除');
        } catch (problem) { setError(problem instanceof Error ? problem.message : '删除失败'); }
        finally { setBusy(false); }
    };
    const open = async (event: React.MouseEvent<HTMLAnchorElement>, handle: string) => {
        event.preventDefault(); setError('');
        // Reserve the new tab during the user gesture, including on Safari.
        const tab = window.open('about:blank', '_blank'); if (tab) tab.opener = null;
        try {
            const response = await apiSocket.request('/v1/preview/access', { method: 'POST', credentials: 'include' });
            if (!response.ok) throw new Error('账号验证失败，请重新登录');
            const url = previewLink(handle, window.location.href);
            if (tab) tab.location.replace(url); else window.location.assign(url);
        } catch (problem) { tab?.close(); setError(problem instanceof Error ? problem.message : '无法打开代理'); }
    };
    const copy = async (value: string) => {
        try { await navigator.clipboard.writeText(value); setNotice('链接已复制'); }
        catch { setError('无法访问剪贴板，请选中链接手动复制'); }
    };
    const filtered = items.filter(item => (filter !== 'mine' || item.canManage) && (filter !== 'shared' || !item.canManage) && `${item.name} ${item.canManage ? item.target : ''}`.toLowerCase().includes(query.toLowerCase()));
    const style = { '--pm-bg': theme.colors.surface, '--pm-panel': theme.colors.surfaceHigh, '--pm-text': theme.colors.text, '--pm-muted': theme.colors.textSecondary, '--pm-line': theme.colors.divider, '--pm-accent': theme.colors.textLink, '--pm-danger': theme.colors.textDestructive } as React.CSSProperties;
    return <div className="hapla-preview-manager" style={style}>
        <div className="pm-heading"><div><h1>服务代理</h1><p>管理服务入口与共享权限。</p></div><button type="button" aria-label="新建代理" className="pm-primary" disabled={busy} onClick={() => edit()}><Ionicons aria-hidden name="add" size={18} color="currentColor" />新建代理</button></div>
        {error && <div ref={alert} className="pm-alert" role="alert">{error}<button type="button" onClick={() => void load()}>刷新列表</button></div>}
        {notice && <p className="pm-notice" role="status">{notice}</p>}
        <div className={`pm-layout${editing !== undefined ? ' is-editing' : ''}`}>
            <section aria-label="代理列表" className="pm-list">
                <div className="pm-list-tools"><div className="pm-tabs" role="group" aria-label="代理范围">{([['all', '全部'], ['mine', '我创建的'], ['shared', '共享给我的']] as const).map(([value, text]) => <button type="button" key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{text}</button>)}</div><input type="search" aria-label="搜索代理" placeholder="搜索代理" value={query} onChange={event => setQuery(event.target.value)} /></div>
                {loading ? <p className="pm-empty" role="status">正在加载代理…</p> : !filtered.length ? <div className="pm-empty"><Ionicons aria-hidden name="globe-outline" size={30} color="currentColor" /><h2>{query ? '没有匹配的代理' : filter === 'shared' ? '暂无共享给你的服务' : '还没有代理'}</h2><p>{filter === 'shared' ? '其他用户选择“Hapla 全部用户”后，服务会显示在这里。' : '点击“新建代理”，选择工作台并填写服务地址。'}</p></div> : filtered.map(item => <article key={item.handle} className={`pm-row${editing?.handle === item.handle ? ' is-selected' : ''}`}>
                    <div className="pm-row-main"><div className="pm-row-title"><a aria-label={item.name} href={previewLink(item.handle, window.location.href)} target="_blank" rel="noopener noreferrer" onClick={event => void open(event, item.handle)}>{item.name}<Ionicons aria-hidden name="open-outline" size={15} color="currentColor" /></a><span className="pm-badge">{accessLabels[item.access ?? 'private']}</span></div>{item.canManage && <p className="pm-target">{item.target}</p>}<a className="pm-url" href={previewLink(item.handle, window.location.href)} target="_blank" rel="noopener noreferrer" onClick={event => void open(event, item.handle)}>{previewLink(item.handle, window.location.href)}</a></div>
                    <div className="pm-row-actions"><button type="button" aria-label={`复制 ${item.name} 的入口`} onClick={() => void copy(previewLink(item.handle, window.location.href))}><Ionicons aria-hidden name="copy-outline" size={17} color="currentColor" /></button>{item.canManage && <button type="button" aria-label={`编辑 ${item.name}`} onClick={() => edit(item)}>编辑</button>}</div>
                </article>)}
            </section>
            {editing !== undefined && <form ref={editor} className="pm-editor" onSubmit={event => void save(event)} aria-label="代理配置">
                <div className="pm-editor-heading"><h2>{editing ? '编辑代理' : '新建代理'}</h2><button type="button" aria-label="关闭代理配置" disabled={busy} onClick={() => { setEditing(undefined); setSecret(null); }}><Ionicons aria-hidden name="close" size={20} color="currentColor" /></button></div>
                <fieldset disabled={busy}><label>名称<input required maxLength={100} value={draft.name} onChange={event => setDraft(previous => ({ ...previous, name: event.target.value }))} placeholder="例如：前端开发" /></label>
                    <label>工作台<select aria-label="工作台" required value={draft.machineId} onChange={event => setDraft(previous => ({ ...previous, machineId: event.target.value }))}><option value="" disabled>选择工作台</option>{machines.map(machine => <option value={machine.id} key={machine.id}>{machine.metadata?.displayName || machine.metadata?.host || machine.id} · {isMachineOnline(machine) ? '在线' : '离线'}</option>)}</select></label>
                    <label>目标服务地址<input required type="url" maxLength={4096} value={draft.target} onChange={event => setDraft(previous => ({ ...previous, target: event.target.value }))} placeholder="http://127.0.0.1:5173/app/" /></label><p className="pm-hint">地址须能从所选工作台访问，支持 HTTP(S)、端口和路径。浏览器访问固定入口时会转发到这里。</p>
                    <label>访问范围<select aria-label="访问范围" value={draft.access} onChange={event => setDraft(previous => ({ ...previous, access: event.target.value as PreviewAccess }))}><option value="private">仅自己</option><option value="users" disabled={!sharing}>Hapla 全部用户</option><option value="key" disabled={!sharing}>公网凭密钥</option></select></label>
                    <p className="pm-hint">{draft.access === 'private' ? '仅当前登录账号能打开。' : draft.access === 'users' ? '此 Hapla 的所有已登录用户可打开，只有你能修改。' : '无需 Hapla 账号，必须持有密钥；保存后生成共享密钥。'}</p>
                    {!sharing && <p className="pm-hint">此实例尚未配置独立预览域名，暂时只能设为仅自己。</p>}
                    <div className="pm-editor-actions"><button type="submit" className="pm-primary">{busy ? '正在保存…' : '保存规则'}</button>{editing && <button type="button" className="pm-danger" onClick={() => void remove()}>删除代理</button>}</div>
                </fieldset>
                {editing && <div className="pm-saved"><label>固定入口<input aria-label="固定入口" readOnly value={previewLink(editing.handle, window.location.href)} onFocus={event => event.target.select()} /></label><a href={previewLink(editing.handle, window.location.href)} target="_blank" rel="noopener noreferrer" onClick={event => void open(event, editing.handle)}>打开服务 <Ionicons aria-hidden name="open-outline" size={14} color="currentColor" /></a></div>}
                {editing?.access === 'key' && <section className="pm-sharing" aria-label="公网共享密钥"><h3>共享密钥</h3><p className="pm-hint">{editing.hasShareKey ? '密钥已启用。重新生成会使旧密钥和访问授权立即失效。' : '尚无有效密钥，公网访问处于关闭状态。'}</p><div className="pm-editor-actions"><button type="button" disabled={busy} onClick={() => void key('rotate')}>{editing.hasShareKey ? '重新生成密钥' : '生成共享密钥'}</button>{editing.hasShareKey && <button type="button" disabled={busy} className="pm-danger" onClick={() => void key('revoke')}>撤销密钥</button>}</div>{secret?.handle === editing.handle && <div className="pm-secret"><label>共享密钥<input type={showSecret ? 'text' : 'password'} aria-label="共享密钥" readOnly value={secret.key} onFocus={event => event.target.select()} /></label><label>带密钥的共享链接<input type={showSecret ? 'text' : 'password'} aria-label="带密钥的共享链接" readOnly value={previewLink(secret.handle, window.location.href, secret.key)} onFocus={event => event.target.select()} /></label><button type="button" onClick={() => void copy(previewLink(secret.handle, window.location.href, secret.key))}>复制共享链接</button><button type="button" onClick={() => setShowSecret(value => !value)}>{showSecret ? '隐藏密钥' : '显示密钥'}</button><button type="button" onClick={() => setSecret(null)}>收起密钥</button></div>}</section>}
            </form>}
        </div>
    </div>;
}
