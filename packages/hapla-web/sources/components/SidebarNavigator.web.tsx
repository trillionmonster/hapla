import * as React from 'react';
import { Slot } from 'expo-router';
import { View, useWindowDimensions } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { useAuth } from '@/auth/AuthContext';
import { useIsTablet } from '@/utils/responsive';

const LazySidebarView = React.lazy(() => import('./SidebarView').then((module) => ({ default: module.SidebarView })));

export const SidebarNavigator = React.memo(function SidebarNavigator() {
    const auth = useAuth();
    const isWide = useIsTablet();
    const { width } = useWindowDimensions();
    const { theme } = useUnistyles();
    const showSidebar = auth.isAuthenticated && isWide;
    const sidebarWidth = React.useMemo(() => Math.min(Math.max(Math.floor(width * 0.24), 300), 360), [width]);

    if (!showSidebar) return <Slot />;

    return (
        <View style={{ flex: 1, flexDirection: 'row', minHeight: 0 }}>
            <View style={{
                width: sidebarWidth,
                flexShrink: 0,
                borderRightWidth: 1,
                borderRightColor: theme.colors.divider,
                backgroundColor: theme.colors.surfaceHigh,
            }}>
                <React.Suspense fallback={<View style={{ flex: 1, backgroundColor: theme.colors.surfaceHigh }} />}>
                    <LazySidebarView />
                </React.Suspense>
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
                <Slot />
            </View>
        </View>
    );
});
