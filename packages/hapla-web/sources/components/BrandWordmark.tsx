import * as React from 'react';
import { View } from 'react-native';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { useUnistyles } from 'react-native-unistyles';
import { BrandMark } from './BrandMark';

export function BrandWordmark({ size = 52 }: { size?: number }) {
    const { theme } = useUnistyles();
    const markSize = Math.max(24, Math.round(size));

    return (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: Math.max(8, Math.round(size * 0.22)), flexShrink: 0 }}>
            <BrandMark size={markSize} />
            <Text
                accessibilityRole="header"
                numberOfLines={1}
                style={{
                    color: theme.colors.text,
                    fontSize: size,
                    lineHeight: size * 1.05,
                    letterSpacing: -size * 0.03,
                    ...Typography.logo(),
                }}
            >
                Hapla
            </Text>
        </View>
    );
}
