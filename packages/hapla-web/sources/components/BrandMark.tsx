import * as React from 'react';
import { Image } from 'expo-image';
import { useUnistyles } from 'react-native-unistyles';

/** The Hapla portal mark, with artwork selected for the surrounding theme. */
export const BrandMark = React.memo(function BrandMark({
    size = 24,
    accessibilityLabel,
}: {
    size?: number;
    accessibilityLabel?: string;
}) {
    const { theme } = useUnistyles();

    return (
        <Image
            source={theme.dark
                ? require('@/assets/images/logo-white.png')
                : require('@/assets/images/logo-black.png')}
            contentFit="contain"
            transition={0}
            accessible={Boolean(accessibilityLabel)}
            accessibilityLabel={accessibilityLabel}
            style={{ width: size, height: size, flexShrink: 0 }}
        />
    );
});
