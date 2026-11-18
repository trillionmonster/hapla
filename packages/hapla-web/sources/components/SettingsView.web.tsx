import * as React from 'react';
import Constants from 'expo-constants';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useLocalSettingMutable, useAllMachines } from '@/sync/storage';
import { isMachineOnline } from '@/utils/machineUtils';

export const SettingsView = React.memo(function SettingsView() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const [devModeEnabled, setDevModeEnabled] = useLocalSettingMutable('devModeEnabled');
    const machines = useAllMachines({ includeOffline: true });
    return (
        <ItemList style={{ paddingTop: 0 }}>
            {machines.length > 0 ? (
                <ItemGroup title="Machines">
                    {machines.map((machine) => {
                        const online = isMachineOnline(machine);
                        return (
                            <Item
                                key={machine.id}
                                title={machine.metadata?.displayName || machine.metadata?.host || 'Unknown machine'}
                                subtitle={online ? 'Online' : 'Offline'}
                                icon={<Ionicons name="desktop-outline" size={26} color={online ? theme.colors.status.connected : theme.colors.status.disconnected} />}
                                onPress={() => router.push(`/machine/${machine.id}`)}
                            />
                        );
                    })}
                </ItemGroup>
            ) : null}
            <ItemGroup title="Workspace">
                <Item title="Account" subtitle="Profile, security and sign out" icon={<Ionicons name="person-circle-outline" size={27} color={theme.colors.textLink} />} onPress={() => router.push('/settings/account')} />
                <Item title="Appearance" subtitle="Theme, font size and code presentation" icon={<Ionicons name="color-palette-outline" size={27} color={theme.colors.textLink} />} onPress={() => router.push('/settings/appearance')} />
                <Item title="New session defaults" subtitle="Agent, real model, output level, and permission mode" icon={<Ionicons name="options-outline" size={27} color={theme.colors.textLink} />} onPress={() => router.push('/settings/defaults')} />
                <Item title="CLI Skills" subtitle="Create and manage Codex and Claude skills" icon={<Ionicons name="extension-puzzle-outline" size={27} color={theme.colors.textLink} />} onPress={() => router.push('/settings/skills')} />
                <Item title="Server" subtitle="Connection and self-hosted server" icon={<Ionicons name="server-outline" size={27} color={theme.colors.textLink} />} onPress={() => router.push('/server')} />
            </ItemGroup>
            <ItemGroup title="高级">
                <Item title="开发诊断" subtitle="在会话中显示原始协议日志入口，仅此设备" detail={devModeEnabled ? '已开启' : '已关闭'} icon={<Ionicons name="code-working-outline" size={27} color={theme.colors.textSecondary} />} onPress={() => setDevModeEnabled(!devModeEnabled)} showChevron={false} />
            </ItemGroup>
            <ItemGroup title="About">
                <Item title="Version" detail={Constants.expoConfig?.version || '1.0.0'} icon={<Ionicons name="information-circle-outline" size={27} color={theme.colors.textSecondary} />} showChevron={false} />
            </ItemGroup>
        </ItemList>
    );
});
