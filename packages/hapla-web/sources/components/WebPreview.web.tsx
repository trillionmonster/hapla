import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { apiSocket } from '@/sync/apiSocket';
import { useSession } from '@/sync/storage';
import { useSessionContinuation } from '@/hooks/useSessionContinuation';
import { useRouter } from 'expo-router';
import { previewLink } from './previewLinks';
import type { PreviewRegistration } from '@hapla/wire';

export function WebPreview(props: { sessionId: string; initialTarget?: string }) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const session = useSession(props.sessionId);
    const prepare = useSessionContinuation(session);
    const [target, setTarget] = React.useState(props.initialTarget ?? '');
    const [result, setResult] = React.useState<{ html?: string; url?: string } | null>(null);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState('');
    const [width, setWidth] = React.useState<'desktop' | 'mobile'>('desktop');
    const [registrations, setRegistrations] = React.useState<PreviewRegistration[]>([]);
    const [selected, setSelected] = React.useState<PreviewRegistration | null>(null);
    React.useEffect(() => {
        let active = true;
        void apiSocket.request('/v1/previews').then(async response => {
            if (!response.ok) throw new Error('无法加载开发代理');
            const data = await response.json();
            if (active) setRegistrations(data.registrations);
        }).catch(problem => { if (active) setError(problem.message); });
        return () => { active = false; };
    }, []);
    const generation = React.useRef(0);
    const frame = React.useRef<HTMLIFrameElement | null>(null);
    React.useEffect(() => () => { generation.current++; frame.current?.removeAttribute('srcdoc'); frame.current?.removeAttribute('src'); }, []);
    const open = async (value = target) => {
        const version = ++generation.current; setBusy(true); setError(''); setResult(null);
        try {
            const text = value.trim(); if (!text) throw new Error('请输入网页地址或 HTML 文件路径');
            if (/^https?:\/\//i.test(text)) {
                const url = new URL(text);
                if (url.username || url.password) throw new Error('请使用不含账号密码的网页地址');
                const machineId = session?.metadata?.machineId;
                if (!machineId) throw new Error('当前会话尚未关联工作台');
                const response = await apiSocket.request('/v1/previews', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ handle: selected?.handle, revision: selected?.revision, name: selected?.name ?? `${url.hostname}:${url.port || (url.protocol === 'https:' ? '443' : '80')}`, machineId, target: url.toString() }) });
                const registration = await response.json();
                if (!response.ok) throw new Error(registration.error || '代理注册失败');
                const access = await apiSocket.request('/v1/preview/access', { method: 'POST', credentials: 'include' });
                if (!access.ok) throw new Error('无法验证当前账号');
                if (version === generation.current) {
                    setSelected(registration);
                    setRegistrations(previous => [registration, ...previous.filter(item => item.handle !== registration.handle)]);
                    setResult({ url: previewLink(registration.handle, window.location.href) });
                }
                return;
            } else if (/^[a-z]+:/i.test(text)) throw new Error('仅支持 HTTP(S) 网页和工作区 HTML 文件');
            if (!session) throw new Error('会话正在加载，请重试');
            const sessionId = await prepare();
            const response = await apiSocket.sessionRPC<{ success: boolean; html?: string; error?: string }, { target: string }>(sessionId, 'preview-document', { target: text });
            if (!response.success || !response.html) throw new Error(response.error || '网页无法加载');
            if (version === generation.current) setResult({ html: response.html });
        } catch (problem) { if (version === generation.current) setError(problem instanceof Error ? problem.message : '网页预览失败'); }
        finally { if (version === generation.current) setBusy(false); }
    };
    React.useEffect(() => { if (props.initialTarget && session) void open(props.initialTarget); }, [props.initialTarget, !!session]);
    const button: React.CSSProperties = { minHeight: 44, padding: '6px 12px', border: `1px solid ${theme.colors.divider}`, borderRadius: 7, background: theme.colors.surfaceHigh, color: theme.colors.text, cursor: 'pointer' };
    return <div style={{ height: '100%', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', background: theme.colors.surface, color: theme.colors.text }}>
        <form onSubmit={event => { event.preventDefault(); void open(); }} style={{ display: 'flex', gap: 8, padding: 12, flexWrap: 'wrap' }}>
            <input aria-label="网页地址或 HTML 路径" placeholder="index.html 或 http://localhost:5173" value={target} onChange={event => setTarget(event.target.value)} style={{ ...button, cursor: 'text', flex: 1, minWidth: 180 }} />
            <button type="button" style={button} onClick={() => router.push('/previews')}>代理管理</button>
            <button type="submit" disabled={busy} style={button}>{busy ? '加载中…' : selected ? '更新目标并打开' : '注册并打开'}</button>
            {selected && <button type="button" style={button} onClick={() => { setSelected(null); setResult(null); }}>新代理</button>}
            <button type="button" aria-pressed={width === 'mobile'} onClick={() => setWidth(value => value === 'mobile' ? 'desktop' : 'mobile')} style={button}>{width === 'mobile' ? '桌面宽度' : '手机宽度'}</button>
            {result?.url && <a href={result.url} target="_blank" rel="noopener noreferrer" style={button}>在浏览器打开</a>}
        </form>
        {registrations.length > 0 && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '0 12px 10px' }}>
            {registrations.map(item => <button key={item.handle} type="button" aria-pressed={selected?.handle === item.handle} style={{ ...button, minHeight: 32, fontSize: 12 }} onClick={() => { setSelected(item); setTarget(item.target); setError(''); void apiSocket.request('/v1/preview/access', { method: 'POST', credentials: 'include' }).then(response => { if (!response.ok) throw new Error('账号验证失败'); setResult({ url: previewLink(item.handle, window.location.href) }); }).catch(problem => setError(problem.message)); }}>{item.name}</button>)}
            {selected && <button type="button" style={{ ...button, fontSize: 12 }} onClick={() => { void apiSocket.request(`/v1/previews/${selected.handle}`, { method: 'DELETE' }).then(response => { if (!response.ok) throw new Error('删除失败'); setRegistrations(items => items.filter(item => item.handle !== selected.handle)); setSelected(null); setResult(null); }).catch(problem => setError(problem.message)); }}>删除此代理</button>}
        </div>}
        {!!error && <div role="alert" style={{ padding: 12, color: theme.colors.textDestructive }}>{error}</div>}
        {!result && !busy && !error && <div style={{ padding: 20 }}>注册工作台可访问的 HTTP(S) 地址，获得固定链接，默认仅自己可访问。可在代理管理中编辑规则和设置共享。更新目标 IP/端口后，原链接继续使用。也可预览工作区 HTML 文件。</div>}
        {result?.url && <div style={{ padding: '0 12px 8px', fontSize: 12, overflowWrap: 'anywhere' }}><a href={result.url} target="_blank" rel="noopener noreferrer" style={{ color: theme.colors.text }}>{result.url}</a><div style={{ color: theme.colors.textSecondary }}>链接使用浏览器当前的 Hapla 地址。服务重启后刷新即可继续访问。</div></div>}
        {result && <iframe ref={frame} key={`${generation.current}:${width}`} title="网页交互预览" src={result.url} srcDoc={result.html} sandbox={result.url ? 'allow-scripts allow-same-origin allow-forms allow-downloads' : 'allow-scripts allow-forms allow-downloads'} referrerPolicy="same-origin"
            style={{ display: 'block', flex: 1, minHeight: 250, width: width === 'mobile' ? 'min(390px, 100%)' : '100%', alignSelf: 'center', border: `1px solid ${theme.colors.divider}`, background: '#fff' }} />}
    </div>;
}
