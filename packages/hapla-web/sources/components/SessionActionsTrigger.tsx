import * as React from 'react';
import { Pressable, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useUnistyles } from 'react-native-unistyles';
import type { SessionActionsAnchor } from './SessionActionsPopover';

export function SessionActionsTrigger({
    label,
    onOpen,
}: {
    label: string;
    onOpen: (anchor: SessionActionsAnchor) => void;
}) {
    const { theme } = useUnistyles();
    const anchorRef = React.useRef<View | null>(null);

    const handlePress = React.useCallback((event: any) => {
        event.stopPropagation?.();
        anchorRef.current?.measureInWindow((x, y, width, height) => {
            onOpen({ type: 'rect', x, y, width, height });
        });
    }, [onOpen]);

    return (
        <View ref={anchorRef} collapsable={false}>
            <Pressable
                accessibilityLabel={label}
                accessibilityRole="button"
                hitSlop={6}
                onPress={handlePress}
                style={({ pressed }) => ({
                    width: 38,
                    height: 44,
                    borderRadius: 10,
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: pressed ? theme.colors.surfacePressed : 'transparent',
                })}
            >
                <Ionicons name="ellipsis-horizontal" size={19} color={theme.colors.textSecondary} />
            </Pressable>
        </View>
    );
}
