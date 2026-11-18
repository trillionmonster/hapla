import * as React from 'react';
import { Pressable, View, useWindowDimensions } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import type { WorkspaceMode } from '@/hooks/useWorkspaceMode';

export type CoderPanel = 'terminal' | null;

export function CoderWorkspaceBar(props: {
    sessionId: string;
    mode: WorkspaceMode;
    panel: CoderPanel;
    onModeChange: (mode: WorkspaceMode) => void;
    onPanelChange: (panel: CoderPanel) => void;
}) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const compact = useWindowDimensions().width < 480;

    return (
        <View style={{
            minHeight: 48,
            flexShrink: 0,
            paddingHorizontal: 12,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 10,
            borderBottomWidth: 1,
            borderBottomColor: theme.colors.divider,
            backgroundColor: theme.colors.surface,
        }}>
            <Pressable
                accessibilityRole="button"
                accessibilityLabel="Coder 模式"
                accessibilityState={{ selected: props.mode === 'coder' }}
                onPress={() => props.onModeChange(props.mode === 'coder' ? 'normal' : 'coder')}
                style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 8,
                    backgroundColor: props.mode === 'coder' ? 'rgba(52, 136, 255, .12)' : 'transparent' }}
            >
                <Text style={{ ...Typography.mono(), fontSize: theme.typography.code.fontSize, fontWeight: '600',
                    color: props.mode === 'coder' ? (theme.dark ? '#469cff' : '#1769d2') : theme.colors.textSecondary }}>{'>_'}</Text>
            </Pressable>

            {props.mode === 'coder' ? (
                <View style={{ flexDirection: 'row', gap: 6 }}>
                    <WorkspaceButton
                        icon="folder-open-outline"
                        label="Files"
                        compact={compact}
                        onPress={() => router.push(`/session/${props.sessionId}/files`)}
                    />
                    <WorkspaceButton
                        icon="terminal-outline"
                        label="Terminal"
                        compact={compact}
                        selected={props.panel === 'terminal'}
                        onPress={() => props.onPanelChange(props.panel === 'terminal' ? null : 'terminal')}
                    />
                </View>
            ) : null}
        </View>
    );
}

function WorkspaceButton(props: {
    icon: React.ComponentProps<typeof Ionicons>['name'];
    label: string;
    selected?: boolean;
    compact?: boolean;
    onPress: () => void;
}) {
    const { theme } = useUnistyles();
    return (
        <Pressable
            accessibilityRole="button"
            accessibilityLabel={props.label}
            accessibilityState={{ selected: props.selected }}
            onPress={props.onPress}
            style={{
                minHeight: 44,
                minWidth: 44,
                width: props.compact ? 44 : undefined,
                flexShrink: 0,
                paddingHorizontal: props.compact ? 0 : 10,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
                borderRadius: 7,
                backgroundColor: props.selected ? theme.colors.surfaceSelected : theme.colors.surfaceHigh,
            }}
        >
            <Ionicons name={props.icon} size={16} color={theme.colors.text} />
            {!props.compact && <Text style={{ fontSize: theme.typography.small.fontSize, color: theme.colors.text }}>{props.label}</Text>}
        </Pressable>
    );
}
