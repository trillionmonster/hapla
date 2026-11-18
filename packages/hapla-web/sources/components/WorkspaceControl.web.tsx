import * as React from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import './workspaceControls.css';

export function useWorkspaceControlStyle(): React.CSSProperties {
    const { theme } = useUnistyles();
    return {
        ...Typography.default(),
        '--workspace-text': theme.colors.text,
        '--workspace-muted': theme.colors.textSecondary,
        '--workspace-surface': theme.colors.surface,
        '--workspace-raised': theme.colors.surfaceHigh,
        '--workspace-selected': theme.colors.surfaceSelected,
        '--workspace-line': theme.colors.divider,
        '--workspace-focus': theme.colors.textLink,
        '--workspace-coder': theme.dark ? '#469cff' : '#1769d2',
        '--workspace-shadow': theme.dark ? '0 1px 3px #0003' : '0 1px 3px #0001',
    } as React.CSSProperties;
}

export function WorkspaceControl(props: {
    label: string;
    accessibilityLabel?: string;
    title?: string;
    icon?: React.ComponentProps<typeof Ionicons>['name'];
    variant?: 'toggle' | 'action' | 'close';
    selected?: boolean;
    onClick: () => void;
}) {
    const { theme } = useUnistyles();
    return (
        <button
            type="button"
            className={`hapla-workspace-control hapla-workspace-control--${props.variant ?? 'action'}`}
            aria-label={props.accessibilityLabel ?? props.label}
            aria-pressed={props.selected}
            title={props.title ?? props.label}
            onClick={props.onClick}
        >
            {props.icon && <Ionicons name={props.icon} size={17} color={props.selected ? theme.colors.text : theme.colors.textSecondary} aria-hidden />}
            <span className="hapla-workspace-control-label">{props.label}</span>
        </button>
    );
}
