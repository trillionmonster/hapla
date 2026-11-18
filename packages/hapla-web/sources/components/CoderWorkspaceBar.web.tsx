import * as React from 'react';
import { useRouter } from 'expo-router';
import type { WorkspaceMode } from '@/hooks/useWorkspaceMode';
import { layout } from './layout';
import { WorkspaceControl, useWorkspaceControlStyle } from './WorkspaceControl.web';

export type CoderPanel = 'terminal' | null;

export function CoderWorkspaceBar(props: {
    sessionId: string;
    mode: WorkspaceMode;
    panel: CoderPanel;
    onModeChange: (mode: WorkspaceMode) => void;
    onPanelChange: (panel: CoderPanel) => void;
}) {
    const router = useRouter();
    const style = useWorkspaceControlStyle();
    return (
        <div className="hapla-workspace-toolbar-shell" style={style}>
            <div className="hapla-workspace-toolbar" style={{ maxWidth: layout.maxWidth }}>
                <WorkspaceControl label=">_" accessibilityLabel="Coder 模式" title={props.mode === 'coder' ? '退出 Coder 模式' : '进入 Coder 模式 · 查看工具与工作区'} variant="toggle" selected={props.mode === 'coder'} onClick={() => props.onModeChange(props.mode === 'coder' ? 'normal' : 'coder')} />
                <WorkspaceControl icon="globe-outline" label="预览" title="在工作区预览网页或 HTML" onClick={() => router.push(`/session/${props.sessionId}/preview`)} />
                {props.mode === 'coder' && <div className="hapla-workspace-actions" role="group" aria-label="工作区工具">
                    <WorkspaceControl icon="folder-open-outline" label="Files" title="浏览工作区文件" onClick={() => router.push(`/session/${props.sessionId}/files`)} />
                    <WorkspaceControl icon="terminal-outline" label="Terminal" title="打开或收起终端" selected={props.panel === 'terminal'} onClick={() => props.onPanelChange(props.panel === 'terminal' ? null : 'terminal')} />
                </div>}
            </div>
        </div>
    );
}
