import * as React from 'react';
import { Platform } from 'react-native';
import Animated from 'react-native-reanimated';
import { StyleSheet } from 'react-native-unistyles';

const stylesheet = StyleSheet.create((theme, runtime) => ({
    container: {
        borderRadius: 12,
        overflow: 'hidden',
        backgroundColor: theme.dark ? theme.colors.surfaceHigh : '#F1F4F8',
        borderWidth: 1,
        borderColor: theme.dark ? theme.colors.modal.border : '#C8D1DC',
        shadowColor: theme.colors.shadow.color,
        shadowOffset: { width: 0, height: 8 },
        shadowRadius: 18,
        shadowOpacity: theme.colors.shadow.opacity,
        elevation: 5,
    },
}));

interface FloatingOverlayProps {
    accessibilityLabel?: string;
    children: React.ReactNode;
    maxHeight?: number;
    showScrollIndicator?: boolean;
    keyboardShouldPersistTaps?: boolean | 'always' | 'never' | 'handled';
}

export const FloatingOverlay = React.memo((props: FloatingOverlayProps) => {
    const styles = stylesheet;
    const { 
        children, 
        maxHeight = 240, 
        showScrollIndicator = false, 
        keyboardShouldPersistTaps = 'handled' 
    } = props;

    return (
        <Animated.View accessibilityLabel={props.accessibilityLabel} style={[styles.container, { maxHeight }]}>
            <Animated.ScrollView
                style={{ maxHeight }}
                keyboardShouldPersistTaps={keyboardShouldPersistTaps}
                showsVerticalScrollIndicator={showScrollIndicator}
            >
                {children}
            </Animated.ScrollView>
        </Animated.View>
    );
});