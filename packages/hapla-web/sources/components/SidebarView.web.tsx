import * as React from 'react';
import { Pressable, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { MainView } from './MainView';
import { useSocketStatus } from '@/sync/storage';
import { BrandWordmark } from './BrandWordmark';

export const SidebarView = React.memo(function SidebarView() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const safeArea = useSafeAreaInsets();
    const socket = useSocketStatus();
    const statusColor = socket.status === 'connected'
        ? theme.colors.status.connected
        : socket.status === 'connecting'
            ? theme.colors.status.connecting
            : theme.colors.status.disconnected;

    return (
        <View style={{ flex: 1, paddingTop: safeArea.top, backgroundColor: theme.colors.groupped.background }}>
            <View style={{ height: 68, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center' }}>
                <View style={{ flex: 1, minWidth: 0 }}>
                    <BrandWordmark size={18} />
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2, marginLeft: 32 }}>
                        <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: statusColor }} />
                        <Text style={{ color: statusColor, fontSize: theme.typography.caption.fontSize, textTransform: 'capitalize' }}>{socket.status}</Text>
                    </View>
                </View>
                <Pressable accessibilityLabel="Settings" onPress={() => router.push('/settings')} style={({ pressed }) => ({ width: 38, height: 38, borderRadius: 10, backgroundColor: pressed ? theme.colors.surfacePressed : 'transparent', alignItems: 'center', justifyContent: 'center' })}>
                    <Ionicons name="settings-outline" size={19} color={theme.colors.text} />
                </Pressable>
                <Pressable accessibilityLabel="New session" onPress={() => router.navigate('/new')} style={({ pressed }) => ({ width: 38, height: 38, borderRadius: 10, backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surface, borderWidth: 1, borderColor: theme.colors.divider, alignItems: 'center', justifyContent: 'center' })}>
                    <Ionicons name="create-outline" size={18} color={theme.colors.text} />
                </Pressable>
            </View>
            <MainView variant="sidebar" />
        </View>
    );
});
