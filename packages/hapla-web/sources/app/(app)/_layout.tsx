import * as React from 'react';
import { Stack } from 'expo-router';
import { Platform } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { createHeader } from '@/components/navigation/Header';
import { FilePreviewHeader } from '@/components/navigation/FilePreviewHeader';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

export const unstable_settings = { initialRouteName: 'index' };

export default function AppLayout() {
    const { theme } = useUnistyles();
    return (
        <Stack
            initialRouteName="index"
            screenOptions={{
                header: Platform.OS === 'web' ? createHeader : undefined,
                headerBackTitle: t('common.back'),
                headerShadowVisible: false,
                contentStyle: { backgroundColor: theme.colors.surface },
                headerStyle: { backgroundColor: theme.colors.header.background },
                headerTintColor: theme.colors.header.tint,
                headerTitleStyle: { color: theme.colors.header.tint, ...Typography.default('semiBold') },
            }}
        >
            <Stack.Screen name="index" options={{ headerShown: false, headerTitle: '' }} />
            <Stack.Screen name="new/index" dangerouslySingular={() => 'new-session'} options={{ headerShown: true, headerTitle: 'New session' }} />
            <Stack.Screen name="session/[id]" options={{ headerShown: false }} />
            <Stack.Screen name="session/recent" options={{ headerShown: true, headerTitle: 'Recent sessions' }} />
            <Stack.Screen name="session/[id]/info" options={{ headerShown: true, headerTitle: 'Session info' }} />
            <Stack.Screen name="session/[id]/files" options={{ headerShown: true, headerTitle: 'Workspace files' }} />
            <Stack.Screen name="session/[id]/file" options={{ headerShown: true, headerTitle: 'File preview', header: Platform.OS === 'web' ? (props) => <FilePreviewHeader {...props} /> : undefined }} />
            <Stack.Screen name="session/[id]/message/[messageId]" options={{ headerShown: true, headerTitle: 'Message' }} />
            <Stack.Screen name="machine/[id]" options={{ headerShown: true, headerTitle: 'Machine' }} />
            <Stack.Screen name="settings/index" options={{ headerShown: true, headerTitle: 'Settings' }} />
            <Stack.Screen name="settings/account" options={{ headerTitle: 'Account' }} />
            <Stack.Screen name="settings/appearance" options={{ headerTitle: 'Appearance' }} />
            <Stack.Screen name="settings/defaults" options={{ headerTitle: 'New session defaults' }} />
            <Stack.Screen name="settings/skills" options={{ headerTitle: 'CLI Skills' }} />
            <Stack.Screen name="settings/skill" options={{ headerTitle: 'Skill editor' }} />
            <Stack.Screen name="previews" options={{ headerTitle: '代理管理' }} />
            <Stack.Screen name="server" options={{ headerTitle: 'Server' }} />
            <Stack.Screen name="terminal/connect" options={{ headerShown: false, headerTitle: 'Connect machine' }} />
            <Stack.Screen name="terminal/index" options={{ headerTitle: 'Connect machine' }} />
            <Stack.Screen name="restore/index" options={{ headerTitle: t('connect.restoreAccount') }} />
            <Stack.Screen name="restore/manual" options={{ headerTitle: t('connect.restoreAccount') }} />
            <Stack.Screen name="media-demo" options={{ headerShown: true, headerTitle: 'Media capability test' }} />
            <Stack.Screen name="acceptance-demo" options={{ headerShown: true, headerTitle: 'Full capability test' }} />
        </Stack>
    );
}
