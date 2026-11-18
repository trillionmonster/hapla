import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { apiSocket } from '@/sync/apiSocket';
import { useSession } from '@/sync/storage';
import { useSessionContinuation } from '@/hooks/useSessionContinuation';

export function WebPreview(props: { sessionId: string; initialTarget?: string }) {
    const { theme } = useUnistyles();
    const session = useSession(props.sessionId);
    const prepare = useSessionContinuation(session);
    const [target, setTarget] = React.useState(props.initialTarget ?? '');
    const [result, setResult] = React.useState<{ html?: string; url?: string } | null>(null);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState('');
    const [width, setWidth] = React.useState<'desktop' | 'mobile'>('desktop');
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
                if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
                    if (window.location.protocol === 'https:' && url.protocol === 'http:') throw new Error('HTTPS 页面需要预览 HTTPS 地址');
                    if (version === generation.current) setResult({ url: url.toString() });
                    return;
                }
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
            <button type="submit" disabled={busy} style={button}>{busy ? '加载中…' : '打开预览'}</button>
            <button type="button" aria-pressed={width === 'mobile'} onClick={() => setWidth(value => value === 'mobile' ? 'desktop' : 'mobile')} style={button}>{width === 'mobile' ? '桌面宽度' : '手机宽度'}</button>
            {result?.url && <a href={result.url} target="_blank" rel="noopener noreferrer" style={button}>在浏览器打开</a>}
        </form>
        {!!error && <div role="alert" style={{ padding: 12, color: theme.colors.textDestructive }}>{error}</div>}
        {!result && !busy && !error && <div style={{ padding: 20 }}>输入工作区 HTML 文件、本地开发服务器地址或可嵌入的网页地址。HTML 预览支持脚本、样式和图片。</div>}
        {result?.url && <div style={{ padding: '0 12px 8px', fontSize: theme.typography.caption.fontSize }}>若网站限制嵌入，请使用“在浏览器打开”。</div>}
        {result && <iframe ref={frame} key={`${generation.current}:${width}`} title="网页交互预览" src={result.url} srcDoc={result.html} sandbox="allow-scripts allow-forms allow-downloads" referrerPolicy="no-referrer"
            style={{ display: 'block', flex: 1, minHeight: 250, width: width === 'mobile' ? 'min(390px, 100%)' : '100%', alignSelf: 'center', border: `1px solid ${theme.colors.divider}`, background: '#fff' }} />}
    </div>;
}
