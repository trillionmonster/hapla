import { View, ScrollView, Pressable, Platform, Linking } from 'react-native';
import { Image } from 'expo-image';
import * as React from 'react';
import { Text } from '@/components/StyledText';
import { useRouter } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import Constants from 'expo-constants';
import { Typography } from "@/constants/Typography";
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useConnectTerminal } from '@/hooks/useConnectTerminal';
import { useLocalSettingMutable, useAllMachines } from '@/sync/storage';
import { isUsingCustomServer } from '@/sync/serverConfig';
import { Modal } from '@/modal';
import { isMachineOnline } from '@/utils/machineUtils';
import { useUnistyles } from 'react-native-unistyles';
import { layout } from '@/components/layout';
import { useProfile } from '@/sync/storage';
import { getDisplayName, getAvatarUrl, getBio } from '@/sync/profile';
import { Avatar } from '@/components/Avatar';
import { BrandWordmark } from '@/components/BrandWordmark';
import { t } from '@/text';

export const SettingsView = React.memo(function SettingsView() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const [devModeEnabled, setDevModeEnabled] = useLocalSettingMutable('devModeEnabled');
    const appVersion = Constants.expoConfig?.version || '1.0.0';
    const isCustomServer = isUsingCustomServer();
    const [showOfflineMachines, setShowOfflineMachines] = React.useState(false);
    const allMachinesWithOffline = useAllMachines({ includeOffline: true });
    const offlineMachineCount = React.useMemo(
        () => allMachinesWithOffline.filter(m => !isMachineOnline(m)).length,
        [allMachinesWithOffline]
    );
    const visibleMachines = React.useMemo(
        () => showOfflineMachines
            ? allMachinesWithOffline
            : allMachinesWithOffline.filter(isMachineOnline),
        [allMachinesWithOffline, showOfflineMachines]
    );
    const profile = useProfile();
    const displayName = getDisplayName(profile);
    const avatarUrl = getAvatarUrl(profile);
    const bio = getBio(profile);

    const { connectTerminal, connectWithUrl, isLoading } = useConnectTerminal();

    return (

        <ItemList style={{ paddingTop: 0 }}>
            {/* App Info Header */}
            <View style={{ maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%' }}>
                <View style={{ alignItems: 'center', paddingVertical: 24, backgroundColor: theme.colors.surface, marginTop: 16, borderRadius: 12, marginHorizontal: 16 }}>
                    {profile.firstName ? (
                        // Profile view: Avatar + name + version
                        <>
                            <View style={{ marginBottom: 12 }}>
                                <Avatar
                                    id={profile.id}
                                    size={90}
                                    imageUrl={avatarUrl}
                                    thumbhash={profile.avatar?.thumbhash}
                                />
                            </View>
                            <Text style={{ fontSize: theme.typography.heading.fontSize, fontWeight: '600', color: theme.colors.text, marginBottom: bio ? 4 : 8 }}>
                                {displayName}
                            </Text>
                            {bio && (
                                <Text style={{ fontSize: theme.typography.label.fontSize, color: theme.colors.textSecondary, textAlign: 'center', marginBottom: 8, paddingHorizontal: 16 }}>
                                    {bio}
                                </Text>
                            )}
                        </>
                    ) : (
                        <BrandWordmark size={48} />
                    )}
                </View>
            </View>

            {/* Connect Terminal - Only show on native platforms */}
            {Platform.OS !== 'web' && (
                <ItemGroup>
                    <Item
                        title={t('settings.scanQrCodeToAuthenticate')}
                        icon={<Ionicons name="qr-code-outline" size={29} color="#007AFF" />}
                        onPress={connectTerminal}
                        loading={isLoading}
                        showChevron={false}
                    />
                    <Item
                        title={t('connect.enterUrlManually')}
                        icon={<Ionicons name="link-outline" size={29} color="#007AFF" />}
                        onPress={async () => {
                            const url = await Modal.prompt(
                                t('modals.authenticateTerminal'),
                                t('modals.pasteUrlFromTerminal'),
                                {
                                    placeholder: 'hapla://terminal?...',
                                    confirmText: t('common.authenticate')
                                }
                            );
                            if (url?.trim()) {
                                connectWithUrl(url.trim());
                            }
                        }}
                        showChevron={false}
                    />
                </ItemGroup>
            )}

            {Platform.OS === 'web' && <ItemGroup><Item title="代理管理" subtitle="固定入口、转发规则与共享权限" icon={<Ionicons name="globe-outline" size={26} color={theme.colors.textLink} />} onPress={() => router.push('/previews')} /></ItemGroup>}

            {/* Machines (sorted: online first, then last seen desc) */}
            {allMachinesWithOffline.length > 0 && (
                <ItemGroup title={t('settings.machines')}>
                    {visibleMachines.map((machine) => {
                        const isOnline = isMachineOnline(machine);
                        const host = machine.metadata?.host || 'Unknown';
                        const displayName = machine.metadata?.displayName;
                        const platform = machine.metadata?.platform || '';

                        // Use displayName if available, otherwise use host
                        const title = displayName || host;

                        // Build subtitle: show hostname if different from title, plus platform and status
                        let subtitle = '';
                        if (displayName && displayName !== host) {
                            subtitle = host;
                        }
                        if (platform) {
                            subtitle = subtitle ? `${subtitle} • ${platform}` : platform;
                        }
                        subtitle = subtitle ? `${subtitle} • ${isOnline ? t('status.online') : t('status.offline')}` : (isOnline ? t('status.online') : t('status.offline'));

                        return (
                            <Item
                                key={machine.id}
                                title={title}
                                subtitle={subtitle}
                                icon={
                                    <Ionicons
                                        name="desktop-outline"
                                        size={29}
                                        color={isOnline ? theme.colors.status.connected : theme.colors.status.disconnected}
                                    />
                                }
                                onPress={() => router.push(`/machine/${machine.id}`)}
                            />
                        );
                    })}
                    {offlineMachineCount > 0 && (
                        <Item
                            title={showOfflineMachines
                                ? t('settings.hideOfflineMachines')
                                : t('settings.showOfflineMachines', { count: offlineMachineCount })}
                            onPress={() => setShowOfflineMachines(v => !v)}
                            showChevron={false}
                            titleStyle={{
                                textAlign: 'center',
                                color: theme.colors.textLink,
                            }}
                        />
                    )}
                </ItemGroup>
            )}

            {/* Features */}
            <ItemGroup title={t('settings.features')}>
                <Item
                    title={t('settings.account')}
                    subtitle={t('settings.accountSubtitle')}
                    icon={<Ionicons name="person-circle-outline" size={29} color="#007AFF" />}
                    onPress={() => router.push('/settings/account')}
                />
                <Item
                    title={t('settings.appearance')}
                    subtitle={t('settings.appearanceSubtitle')}
                    icon={<Ionicons name="color-palette-outline" size={29} color="#5856D6" />}
                    onPress={() => router.push('/settings/appearance')}
                />
                <Item
                    title="New session defaults"
                    subtitle="Agent, real model, output level, and permission mode"
                    icon={<Ionicons name="options-outline" size={29} color="#0A84FF" />}
                    onPress={() => router.push('/settings/defaults')}
                />
                <Item
                    title="CLI Skills"
                    subtitle="Discover and manage skills exposed by Claude Code and Codex"
                    icon={<Ionicons name="extension-puzzle-outline" size={29} color="#0A84FF" />}
                    onPress={() => router.push('/settings/skills')}
                />
                <Item
                    title="全功能展示验收"
                    subtitle="检查 Markdown、HTML 沙箱和多模态实际组件"
                    icon={<Ionicons name="checkmark-done-circle-outline" size={29} color="#30A46C" />}
                    onPress={() => router.push('/acceptance-demo')}
                />
                <Item
                    title="多模态能力测试"
                    subtitle="检查图片、音频、视频、进度拖动、全屏和错误态"
                    icon={<Ionicons name="images-outline" size={29} color="#FF8A3D" />}
                    onPress={() => router.push('/media-demo')}
                />
            </ItemGroup>

            <ItemGroup title="开发诊断">
                <Item
                    title="开发诊断"
                    subtitle="在会话中显示原始协议日志入口，仅此设备"
                    detail={devModeEnabled ? '已开启' : '已关闭'}
                    icon={<Ionicons name="code-working-outline" size={29} color={theme.colors.textSecondary} />}
                    onPress={() => setDevModeEnabled(!devModeEnabled)}
                    showChevron={false}
                />
            </ItemGroup>

            {/* About */}
            <ItemGroup title={t('settings.about')} footer={t('settings.aboutFooter')}>
                {Platform.OS === 'ios' && (
                    <Item
                        title={t('settings.eula')}
                        icon={<Ionicons name="document-text-outline" size={29} color="#007AFF" />}
                        onPress={async () => {
                            const url = 'https://www.apple.com/legal/internet-services/itunes/dev/stdeula/';
                            const supported = await Linking.canOpenURL(url);
                            if (supported) {
                                await Linking.openURL(url);
                            }
                        }}
                    />
                )}
                <Item
                    title={t('common.version')}
                    detail={appVersion}
                    icon={<Ionicons name="information-circle-outline" size={29} color={theme.colors.textSecondary} />}
                    showChevron={false}
                />
            </ItemGroup>

        </ItemList>
    );
});
