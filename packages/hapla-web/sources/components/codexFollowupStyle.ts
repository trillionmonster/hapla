import { useUnistyles } from 'react-native-unistyles';
import type { CSSProperties } from 'react';
import { Typography } from '@/constants/Typography';

export function useCodexFollowupStyle(): CSSProperties {
    const { theme } = useUnistyles();
    return {
        ...Typography.default(),
        '--followup-text': theme.colors.text,
        '--followup-muted': theme.colors.textSecondary,
        '--followup-surface': theme.colors.surface,
        '--followup-raised': theme.colors.surfaceHigh,
        '--followup-line': theme.colors.divider,
        '--followup-hover': theme.colors.surfacePressed,
        '--followup-accent': theme.colors.textLink,
        '--followup-danger': theme.colors.textDestructive,
        '--followup-shadow': theme.dark ? '0 12px 40px #0006' : '0 12px 40px #17212c18',
    } as CSSProperties;
}
