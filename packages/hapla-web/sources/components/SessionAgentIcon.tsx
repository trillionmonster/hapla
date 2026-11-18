import * as React from 'react';
import { View } from 'react-native';
import { Image } from 'expo-image';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useUnistyles } from 'react-native-unistyles';

const agentAssets = {
    claude: require('@/assets/images/icon-claude.png'),
    codex: require('@/assets/images/icon-gpt.png'),
};

export function sessionAgentLabel(flavor: string | null): string {
    if (flavor === 'codex') return 'Codex';
    if (flavor === 'claude') return 'Claude';
    return 'Agent';
}

export const SessionAgentIcon = React.memo(function SessionAgentIcon({
    flavor,
    size = 38,
}: {
    flavor: string | null;
    size?: number;
}) {
    const { theme } = useUnistyles();
    const iconSize = Math.round(size * 0.5);
    const source = agentAssets[flavor as keyof typeof agentAssets];

    return (
        <View
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={{
                width: size,
                height: size,
                borderRadius: 11,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: theme.colors.surfaceHigh,
                borderWidth: 1,
                borderColor: theme.colors.divider,
            }}
        >
            {source ? (
                <Image
                    source={source}
                    contentFit="contain"
                    style={{ width: iconSize, height: iconSize }}
                    tintColor={flavor === 'codex' ? theme.colors.text : undefined}
                />
            ) : (
                <Ionicons name="terminal-outline" size={iconSize} color={theme.colors.textSecondary} />
            )}
        </View>
    );
});
