import type { Theme } from '@/theme';
import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import type { ToolViewProps } from './_all';
import {
    sessionCallMcpAppTool,
    sessionReadMcpAppResource,
    sessionSubmitMcpAppIntent,
    type McpAppResourceContent,
} from '@/sync/ops';

type AppDescriptor = {
    protocolVersion: number;
    server: string;
    tool: string;
    resourceUri: string | null;
    appContext?: unknown;
    pluginId?: string | null;
};

type JsonRpcMessage = {
    jsonrpc?: string;
    id?: string | number;
    method?: string;
    params?: any;
};

function descriptorFromTool(tool: ToolViewProps['tool']): AppDescriptor | null {
    const candidate = tool.input?.__haplaMcpApp ?? tool.result?.__haplaMcpApp;
    if (!candidate || typeof candidate !== 'object') return null;
    if (typeof candidate.server !== 'string' || typeof candidate.tool !== 'string') return null;
    return candidate as AppDescriptor;
}

function cspDomains(meta: unknown, key: 'connectDomains' | 'resourceDomains' | 'frameDomains'): string[] {
    const value = (meta as any)?.ui?.csp?.[key];
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === 'string' && /^https:\/\//i.test(item));
}

function addHostPolicy(html: string, content: McpAppResourceContent): string {
    const connect = cspDomains(content._meta, 'connectDomains');
    const resources = cspDomains(content._meta, 'resourceDomains');
    const frames = cspDomains(content._meta, 'frameDomains');
    const policy = [
        "default-src 'none'",
        `script-src 'unsafe-inline' ${resources.join(' ')}`.trim(),
        `style-src 'unsafe-inline' ${resources.join(' ')}`.trim(),
        `img-src data: blob: ${resources.length ? resources.join(' ') : "'none'"}`,
        `media-src blob: ${resources.length ? resources.join(' ') : "'none'"}`,
        `font-src data: ${resources.join(' ')}`.trim(),
        `connect-src ${connect.length ? connect.join(' ') : "'none'"}`,
        `frame-src ${frames.length ? frames.join(' ') : "'none'"}`,
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
    ].join('; ');
    const meta = `<meta http-equiv="Content-Security-Policy" content="${policy.replace(/"/g, '&quot;')}">`;
    const language = '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><script>document.documentElement.lang="zh-CN";</script>';
    if (/<head[\s>]/i.test(html)) {
        return html.replace(/<head([^>]*)>/i, `<head$1>${meta}${language}`);
    }
    return `<!doctype html><html><head>${meta}${language}</head><body>${html}</body></html>`;
}

function textFromUiMessage(params: any): string {
    if (typeof params?.text === 'string') return params.text;
    if (!Array.isArray(params?.content)) return '';
    return params.content
        .filter((item: any) => item?.type === 'text' && typeof item.text === 'string')
        .map((item: any) => item.text)
        .join('\n');
}

function publicToolInput(tool: ToolViewProps['tool']): Record<string, unknown> {
    if (!tool.input || typeof tool.input !== 'object') return {};
    const { __haplaMcpApp: _hostOnly, ...input } = tool.input;
    return input;
}

function publicToolResult(tool: ToolViewProps['tool']): any {
    if (!tool.result || typeof tool.result !== 'object') return tool.result ?? null;
    return tool.result.value ?? tool.result;
}

type McpAppSurfaceProps = ToolViewProps & {
    workspace?: boolean;
    onClose?: () => void;
};

export const McpAppSurface = React.memo<McpAppSurfaceProps>(({ tool, sessionId, workspace = false, onClose }) => {
    const { theme } = useUnistyles();
    const styles = getStyles(theme);
    const descriptor = descriptorFromTool(tool);
    const frameRef = React.useRef<HTMLIFrameElement | null>(null);
    const modelContextRef = React.useRef<unknown>(null);
    const [html, setHtml] = React.useState<string | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [mounted, setMounted] = React.useState(true);
    const [expanded, setExpanded] = React.useState(false);

    React.useEffect(() => {
        if (!expanded) return;
        const previousOverflow = document.body.style.overflow;
        const closeOnEscape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setExpanded(false);
        };
        document.body.style.overflow = 'hidden';
        window.addEventListener('keydown', closeOnEscape);
        return () => {
            document.body.style.overflow = previousOverflow;
            window.removeEventListener('keydown', closeOnEscape);
        };
    }, [expanded]);

    React.useEffect(() => {
        let cancelled = false;
        setHtml(null);
        setError(null);
        if (!mounted || !sessionId || !descriptor?.resourceUri) return () => { cancelled = true; };

        void sessionReadMcpAppResource(sessionId, {
            server: descriptor.server,
            resourceUri: descriptor.resourceUri,
        }).then((response) => {
            if (cancelled) return;
            const content = response.contents.find((item) => (
                'text' in item && item.uri === descriptor.resourceUri
            )) ?? response.contents.find((item) => 'text' in item);
            if (!content || !('text' in content)) {
                throw new Error('该 MCP App 没有返回可渲染的 HTML 资源。');
            }
            const mime = content.mimeType ?? '';
            if (!mime.toLowerCase().startsWith('text/html')) {
                throw new Error(`不支持的 MCP App MIME 类型：${mime || 'unknown'}`);
            }
            setHtml(addHostPolicy(content.text, content));
        }).catch((reason) => {
            if (!cancelled) setError(reason instanceof Error ? reason.message : '交互页面加载失败。');
        });
        return () => { cancelled = true; };
    }, [descriptor?.resourceUri, descriptor?.server, mounted, sessionId]);

    const notifyApp = React.useCallback((method: string, params: unknown) => {
        frameRef.current?.contentWindow?.postMessage({ jsonrpc: '2.0', method, params }, '*');
    }, []);

    const hydrateApp = React.useCallback(() => {
        notifyApp('ui/notifications/tool-input', publicToolInput(tool));
        notifyApp('ui/notifications/tool-result', publicToolResult(tool));
    }, [notifyApp, tool]);

    React.useEffect(() => {
        if (!html) return;
        const onMessage = async (event: MessageEvent) => {
            if (event.source !== frameRef.current?.contentWindow) return;
            const message = event.data as JsonRpcMessage;
            if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return;

            const respond = (result?: unknown, rpcError?: { code: number; message: string }) => {
                if (message.id === undefined) return;
                frameRef.current?.contentWindow?.postMessage({
                    jsonrpc: '2.0',
                    id: message.id,
                    ...(rpcError ? { error: rpcError } : { result: result ?? {} }),
                }, '*');
            };

            try {
                if (message.method === 'ui/initialize') {
                    respond({
                        protocolVersion: message.params?.protocolVersion ?? '2026-01-26',
                        hostInfo: { name: 'hapla', version: '1' },
                        hostCapabilities: {
                            tools: { call: true },
                            messaging: true,
                            modelContext: true,
                        },
                        hostContext: { displayMode: expanded ? 'fullscreen' : (workspace ? 'panel' : 'inline') },
                    });
                    return;
                }

                if (message.method === 'ui/notifications/initialized') {
                    hydrateApp();
                    return;
                }

                if (message.method === 'tools/call') {
                    if (!sessionId || !descriptor?.resourceUri) throw new Error('Hapla 会话不可用。');
                    const result = await sessionCallMcpAppTool(sessionId, {
                        server: descriptor.server,
                        resourceUri: descriptor.resourceUri,
                        tool: message.params?.name,
                        arguments: message.params?.arguments ?? {},
                        meta: message.params?._meta,
                    });
                    respond(result);
                    notifyApp('ui/notifications/tool-result', result);
                    return;
                }

                if (message.method === 'ui/update-model-context') {
                    if (JSON.stringify(message.params ?? null).length > 128 * 1024) {
                        throw new Error('模型上下文超过 128 KiB。');
                    }
                    modelContextRef.current = message.params ?? null;
                    respond({});
                    return;
                }

                if (message.method === 'ui/message' || message.method === 'hapla/submit') {
                    if (!sessionId || !descriptor?.resourceUri) throw new Error('Hapla 会话不可用。');
                    const text = message.method === 'ui/message'
                        ? textFromUiMessage(message.params)
                        : String(message.params?.text ?? '');
                    const context = modelContextRef.current == null
                        ? ''
                        : `\n\n交互页面上下文：\n${JSON.stringify(modelContextRef.current)}`;
                    const result = await sessionSubmitMcpAppIntent(sessionId, {
                        server: descriptor.server,
                        resourceUri: descriptor.resourceUri,
                        text: text + context,
                        images: message.params?.images,
                        skill: message.params?.skill,
                    });
                    respond(result);
                    notifyApp('hapla/notifications/intent-queued', result);
                    return;
                }

                respond(undefined, { code: -32601, message: `Hapla 不支持 ${message.method}` });
            } catch (reason) {
                respond(undefined, {
                    code: -32000,
                    message: reason instanceof Error ? reason.message : 'MCP App 请求失败。',
                });
            }
        };
        window.addEventListener('message', onMessage);
        return () => window.removeEventListener('message', onMessage);
    }, [descriptor, expanded, html, hydrateApp, notifyApp, sessionId]);

    if (!descriptor?.resourceUri) return null;

    const content = (
        <div style={{ ...styles.surface, ...(workspace ? styles.workspaceSurface : {}), background: theme.colors.surface, color: theme.colors.text, borderColor: theme.colors.divider, ...(expanded ? styles.fullSurface : {}) }}>
            <div style={{ ...styles.toolbar, background: theme.colors.surfaceHigh, borderBottomColor: theme.colors.divider }}>
                <div style={styles.identity}>
                    <strong style={styles.title}>{descriptor.appContext && (descriptor.appContext as any).appName || descriptor.tool}</strong>
                    <span style={{ ...styles.subtitle, color: theme.colors.textSecondary }}>{descriptor.server}</span>
                </div>
                <div style={styles.actions}>
                    <button type="button" style={{ ...styles.secondaryButton, borderColor: theme.colors.divider, background: theme.colors.surface, color: theme.colors.text }} onClick={() => setMounted((value) => !value)}>
                        {mounted ? '卸载' : '重新加载'}
                    </button>
                    <button type="button" style={{ ...styles.primaryButton, background: theme.colors.button.primary.background, color: theme.colors.button.primary.tint }} onClick={() => setExpanded((value) => !value)}>
                        {expanded ? '收起' : '展开'}
                    </button>
                    {workspace && onClose ? (
                        <button type="button" aria-label="关闭交互式 Skill 工作区" style={{ ...styles.iconButton, borderColor: theme.colors.divider, background: theme.colors.surface, color: theme.colors.text }} onClick={onClose}>×</button>
                    ) : null}
                </div>
            </div>
            <div style={{ ...styles.frameStage, background: theme.colors.surface }}>
                {!mounted ? (
                    <div style={{ ...styles.empty, color: theme.colors.textSecondary }}>页面已卸载，状态仍由 Skill 服务保存。</div>
                ) : error ? (
                    <div role="alert" style={{ ...styles.error, color: theme.colors.textDestructive, borderColor: theme.colors.textDestructive }}>{error}</div>
                ) : !html ? (
                    <div aria-label="正在加载交互页面" style={styles.skeleton}>
                        <span style={styles.skeletonWide} />
                        <span style={styles.skeletonNarrow} />
                        <span style={styles.skeletonCanvas} />
                    </div>
                ) : (
                    <iframe
                        ref={frameRef}
                        title={`${descriptor.tool} 交互页面`}
                        srcDoc={html}
                        sandbox="allow-scripts allow-forms"
                        referrerPolicy="no-referrer"
                        style={{ ...styles.frame, background: theme.colors.surface, ...(workspace ? styles.workspaceFrame : {}), ...(expanded ? styles.fullFrame : {}) }}
                        onLoad={hydrateApp}
                    />
                )}
            </div>
        </div>
    );

    return expanded ? <div role="dialog" aria-modal="true" style={styles.overlay}>{content}</div> : content;
});

const getStyles = (theme: Theme): Record<string, React.CSSProperties> => ({
    surface: { display: 'flex', flexDirection: 'column', width: '100%', minHeight: 420, maxHeight: 'calc(100dvh - 32px)', overflow: 'hidden', border: '1px solid rgba(100,116,139,.24)', borderRadius: 14, background: '#f7f8fa', color: '#17202a', boxShadow: '0 18px 48px rgba(35,48,60,.12)' },
    workspaceSurface: { height: '100%', minHeight: 0, maxHeight: 'none', borderRadius: 0, borderTop: 0, borderBottom: 0, boxShadow: 'none' },
    fullSurface: { height: '100%', maxHeight: 'none' },
    overlay: { position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', padding: 'max(12px, env(safe-area-inset-top)) max(12px, env(safe-area-inset-right)) max(12px, env(safe-area-inset-bottom)) max(12px, env(safe-area-inset-left))', background: 'rgba(20,27,34,.72)', backdropFilter: 'blur(10px)' },
    toolbar: { minHeight: 58, display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '10px 12px 10px 16px', borderBottom: '1px solid rgba(100,116,139,.18)', background: '#eef1f4' },
    identity: { minWidth: 120, flex: '1 1 160px', display: 'flex', flexDirection: 'column', gap: 2 },
    title: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: theme.typography.label.fontSize, fontWeight: 650 },
    subtitle: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#637083', fontSize: theme.typography.caption.fontSize },
    actions: { display: 'flex', flex: '0 0 auto', marginLeft: 'auto', gap: 8 },
    primaryButton: { minHeight: 44, padding: '0 14px', border: 0, borderRadius: 9, background: '#176b57', color: '#f7fffc', fontSize: theme.typography.small.fontSize, fontWeight: 650, cursor: 'pointer', whiteSpace: 'nowrap' },
    secondaryButton: { minHeight: 44, padding: '0 12px', border: '1px solid rgba(82,96,112,.3)', borderRadius: 9, background: '#f8fafb', color: '#273342', fontSize: theme.typography.small.fontSize, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' },
    iconButton: { width: 44, height: 44, padding: 0, border: '1px solid rgba(82,96,112,.3)', borderRadius: 9, fontSize: theme.typography.heading.fontSize, lineHeight: `${theme.typography.heading.lineHeight}px`, cursor: 'pointer' },
    frameStage: { position: 'relative', flex: 1, minHeight: 360, background: '#f7f8fa' },
    frame: { display: 'block', width: '100%', height: 'min(68dvh, 720px)', minHeight: 360, border: 0, background: '#f7f8fa' },
    workspaceFrame: { height: '100%', minHeight: 0 },
    fullFrame: { height: '100%', maxHeight: 'none' },
    empty: { display: 'grid', minHeight: 360, placeItems: 'center', padding: 24, color: '#637083', fontSize: theme.typography.label.fontSize, textAlign: 'center' },
    error: { margin: 18, padding: 16, borderRadius: 10, border: '1px solid rgba(177,68,62,.3)', background: '#fff4f2', color: '#8d2f2b', fontSize: theme.typography.label.fontSize, lineHeight: 1.5 },
    skeleton: { display: 'flex', flexDirection: 'column', gap: 12, minHeight: 360, padding: 22 },
    skeletonWide: { display: 'block', width: '44%', height: 22, borderRadius: 7, background: '#e2e7eb' },
    skeletonNarrow: { display: 'block', width: '28%', height: 12, borderRadius: 6, background: '#e7ebee' },
    skeletonCanvas: { display: 'block', flex: 1, minHeight: 260, marginTop: 8, borderRadius: 11, background: '#e6eaed' },
});
