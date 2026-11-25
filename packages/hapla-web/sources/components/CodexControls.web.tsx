import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import type { CodexControlsProps } from './CodexControls';
import { resolveCodexServiceTier } from '@/sync/codexPreferences';

const effortLabels: Record<string, string> = { default: '默认', none: '不思考', minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '超高', max: '最高', ultra: 'Ultra' };
export function CodexControls(props: CodexControlsProps) {
    const { theme } = useUnistyles();
    const serviceTier = resolveCodexServiceTier(props.preferences.serviceTier, props.serviceTiers ?? []);
    const style: React.CSSProperties = { minHeight: 32, width: 112, flexShrink: 0, background: theme.colors.surface, color: theme.colors.text, border: `1px solid ${theme.colors.divider}`, borderRadius: 8, padding: '6px 8px', fontSize: 13 };
    const labelStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 };
    const explanation = (title: string, hint: string) => <span style={{ minWidth: 0 }}><span style={{ display: 'block', color: theme.colors.text, fontSize: 13 }}>{title}</span><span style={{ display: 'block', marginTop: 3, fontSize: 12, lineHeight: '17px' }}>{hint}</span></span>;
    const fast = props.serviceTiers?.includes('fast') || props.serviceTiers?.includes('priority');
    return <div role="group" aria-label="Codex 设置" style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '16px', fontSize: 12, color: theme.colors.textSecondary, borderBottom: `1px solid ${theme.colors.divider}` }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}><strong style={{ color: theme.colors.text, fontSize: 13 }}>回复设置</strong><span>主任务下一轮 · 旁问本次生效</span></div>
        <label style={labelStyle}>{explanation('工作模式', '执行：直接做；规划：先给方案。')}<select aria-label="Codex 工作模式" style={style} value={props.preferences.collaborationMode} onChange={event => props.onChange({ collaborationMode: event.target.value as 'default' | 'plan' })}>
            <option value="default">执行</option><option value="plan">规划</option>
        </select></label>
        {props.efforts.length > 0 && props.onEffortChange && <label style={labelStyle}>{explanation('思考深度', '复杂任务可调高，通常需要更久。')}<select aria-label="思考深度" style={style} value={props.effort?.key ?? 'default'} onChange={event => {
            const level = props.efforts.find(option => option.key === event.target.value); if (level) props.onEffortChange?.(level);
        }}>
            {props.efforts.map(option => <option key={option.key} value={option.key}>{effortLabels[option.key] ?? option.name}</option>)}
        </select></label>}
        <label style={labelStyle}>{explanation('回复长度', '选择简洁回答或详细解释。')}<select aria-label="输出详略" style={style} value={props.preferences.verbosity} onChange={event => props.onChange({ verbosity: event.target.value as CodexControlsProps['preferences']['verbosity'] })}>
            <option value="default">默认</option><option value="low">简洁</option><option value="medium">适中</option><option value="high">详细</option>
        </select></label>
        <label style={labelStyle}>{explanation('响应速度', fast ? 'Fast 更快，会消耗更多额度。' : '当前模型未提供 Fast。')}<select aria-label="响应速度" style={style} value={serviceTier} onChange={event => props.onChange({ serviceTier: event.target.value })}>
            <option value="default">默认</option><option value="standard">标准</option><option value={props.serviceTiers?.includes('fast') ? 'fast' : 'priority'} disabled={!fast}>{fast ? 'Fast' : 'Fast（此模型未提供）'}</option>
            {(props.serviceTiers ?? []).filter(tier => !['fast', 'priority', 'default', 'standard'].includes(tier)).map(tier => <option key={tier} value={tier}>{tier}</option>)}
        </select></label>
    </div>;
}
