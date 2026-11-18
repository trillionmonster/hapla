import * as React from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import { SessionsList } from './SessionsList';
import { EmptySessionsTablet } from './EmptySessionsTablet';
import { Header } from './navigation/Header';
import { BrandWordmark } from './BrandWordmark';
import { useVisibleSessionListViewData } from '@/hooks/useVisibleSessionListViewData';
import { useIsTablet } from '@/utils/responsive';

export const MainView = React.memo(function MainView({ variant }: { variant: 'phone' | 'sidebar' }) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const sessions = useVisibleSessionListViewData();
    const isTablet = useIsTablet();

    // Warm the wizard route as soon as the home screen is usable. Starting the
    // prefetch from onPressIn made the first mobile tap pay the entire lazy-load
    // cost and gave no visual acknowledgement, which looked like a missed tap.
    React.useEffect(() => {
        router.prefetch('/new');
    }, [router]);

    const openNewSession = React.useCallback(() => {
        router.push('/new');
    }, [router]);

    if (variant === 'phone' && isTablet) return <View style={{ flex: 1, backgroundColor: theme.colors.surface }} />;
    if (sessions === null) {
        return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator color={theme.colors.textSecondary} /></View>;
    }
    const list = sessions.length === 0 ? <EmptySessionsTablet /> : <SessionsList />;
    if (variant === 'sidebar') return <View style={{ flex: 1, minHeight: 0 }}>{list}</View>;

    return (
        <View style={{ flex: 1, minHeight: 0 }}>
            <Header
                title={<BrandWordmark size={26} />}
                headerLeft={() => null}
                headerRight={() => (
                    <View style={{ flexDirection: 'row', gap: 4 }}>
                        <Pressable
                            accessibilityRole="button"
                            accessibilityLabel="Open settings"
                            onHoverIn={() => router.prefetch('/settings')}
                            onPressIn={() => router.prefetch('/settings')}
                            onPress={() => router.push('/settings')}
                            style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 10 }}
                        >
                            <Ionicons name="settings-outline" size={21} color={theme.colors.header.tint} />
                        </Pressable>
                        <Pressable
                            accessibilityRole="button"
                            accessibilityLabel="New session"
                            accessibilityHint="Open the new session screen"
                            hitSlop={6}
                            onPress={openNewSession}
                            style={({ pressed }) => ({
                                width: 44,
                                height: 44,
                                alignItems: 'center',
                                justifyContent: 'center',
                                borderRadius: 10,
                                backgroundColor: pressed ? theme.colors.surfacePressed : 'transparent',
                            })}
                        >
                            <Ionicons name="add" size={25} color={theme.colors.header.tint} />
                        </Pressable>
                    </View>
                )}
                headerShadowVisible={false}
            />
            <View style={{ flex: 1, minHeight: 0 }}>{list}</View>
        </View>
    );
});
