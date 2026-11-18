import * as React from 'react';
import {
    ActivityIndicator,
    FlatList,
    Pressable,
    TextInput,
    View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { Switch } from '@/components/Switch';
import { Typography } from '@/constants/Typography';
import { useAllMachines } from '@/sync/storage';
import {
    machineRefreshCliCapabilities,
    machineSetCodexSkillEnabled,
} from '@/sync/ops';
import { isMachineOnline } from '@/utils/machineUtils';

type Provider = 'codex' | 'claude';

export default function SkillsSettingsScreen() {
    const router = useRouter();
    const { theme } = useUnistyles();
    const machines = useAllMachines({ includeOffline: true });
    const [machineId, setMachineId] = React.useState<string | null>(null);
    const [provider, setProvider] = React.useState<Provider>('codex');
    const [query, setQuery] = React.useState('');
    const [refreshing, setRefreshing] = React.useState(false);
    const [pendingSkill, setPendingSkill] = React.useState<string | null>(null);

    const sortedMachines = React.useMemo(
        () => [...machines].sort((a, b) => Number(isMachineOnline(b)) - Number(isMachineOnline(a))),
        [machines],
    );
    const selectedMachine = sortedMachines.find((machine) => machine.id === machineId) ?? sortedMachines[0];
    const catalog = selectedMachine?.metadata?.cliCapabilities?.[provider];
    const skills = React.useMemo(() => {
        const normalizedQuery = query.trim().toLowerCase();
        if (!normalizedQuery) {
            return catalog?.skills ?? [];
        }
        return (catalog?.skills ?? []).filter((skill) =>
            `${skill.name} ${skill.description} ${skill.scope ?? ''}`.toLowerCase().includes(normalizedQuery),
        );
    }, [catalog?.skills, query]);

    React.useEffect(() => {
        if (selectedMachine && selectedMachine.id !== machineId) {
            setMachineId(selectedMachine.id);
        }
    }, [machineId, selectedMachine]);

    const refresh = React.useCallback(async () => {
        if (!selectedMachine || !isMachineOnline(selectedMachine)) {
            return;
        }
        setRefreshing(true);
        try {
            await machineRefreshCliCapabilities(selectedMachine.id);
        } finally {
            setRefreshing(false);
        }
    }, [selectedMachine]);

    const setEnabled = React.useCallback(async (skill: NonNullable<typeof catalog>['skills'][number], enabled: boolean) => {
        if (!selectedMachine || provider !== 'codex' || !skill.path) {
            return;
        }
        setPendingSkill(skill.path);
        try {
            await machineSetCodexSkillEnabled({
                machineId: selectedMachine.id,
                name: skill.name,
                path: skill.path,
                enabled,
            });
        } finally {
            setPendingSkill(null);
        }
    }, [provider, selectedMachine]);

    const isOnline = selectedMachine ? isMachineOnline(selectedMachine) : false;
    const openSkill = React.useCallback((skill?: NonNullable<typeof catalog>['skills'][number]) => {
        if (!selectedMachine || !isOnline) return;
        router.push({
            pathname: '/settings/skill',
            params: {
                machineId: selectedMachine.id,
                provider,
                ...(skill?.path ? { path: skill.path } : {}),
                ...(skill?.name ? { name: skill.name } : {}),
            },
        } as any);
    }, [isOnline, provider, router, selectedMachine]);
    const header = (
        <View style={{ gap: 16, paddingHorizontal: 16, paddingTop: 18, paddingBottom: 12 }}>
            <View>
                <Text style={{ fontSize: theme.typography.title.fontSize, color: theme.colors.text, ...Typography.default('semiBold') }}>
                    CLI Skills
                </Text>
                <Text style={{ marginTop: 4, fontSize: theme.typography.label.fontSize, lineHeight: theme.typography.label.lineHeight, color: theme.colors.textSecondary }}>
                    Catalogs come directly from each installed CLI. Codex skills can be enabled or disabled here.
                </Text>
            </View>

            <View style={{ gap: 8 }}>
                <Text style={{ fontSize: theme.typography.caption.fontSize, color: theme.colors.textSecondary, ...Typography.default('semiBold') }}>
                    MACHINE
                </Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                    {sortedMachines.map((machine) => {
                        const selected = machine.id === selectedMachine?.id;
                        return (
                            <Pressable
                                key={machine.id}
                                onPress={() => setMachineId(machine.id)}
                                accessibilityRole="button"
                                accessibilityLabel={`Use machine ${machine.metadata?.displayName || machine.metadata?.host || 'unknown'}`}
                                accessibilityState={{ selected }}
                                style={{
                                    minHeight: 44,
                                    justifyContent: 'center',
                                    paddingHorizontal: 14,
                                    borderRadius: 8,
                                    backgroundColor: selected ? theme.colors.surfaceSelected : theme.colors.surfaceHigh,
                                    borderWidth: 1,
                                    borderColor: selected ? theme.colors.textLink : theme.colors.divider,
                                }}
                            >
                                <Text style={{ color: theme.colors.text, fontSize: theme.typography.label.fontSize }}>
                                    {machine.metadata?.displayName || machine.metadata?.host || 'Unknown machine'}
                                    {!isMachineOnline(machine) ? ' / offline' : ''}
                                </Text>
                            </Pressable>
                        );
                    })}
                </View>
            </View>

            <View style={{ flexDirection: 'row', gap: 8 }}>
                {(['codex', 'claude'] as const).map((value) => (
                    <Pressable
                        key={value}
                        onPress={() => setProvider(value)}
                        accessibilityRole="button"
                        accessibilityLabel={`Show ${value} skills`}
                        accessibilityState={{ selected: provider === value }}
                        style={{
                            flex: 1,
                            minHeight: 44,
                            alignItems: 'center',
                            justifyContent: 'center',
                            borderRadius: 8,
                            backgroundColor: provider === value ? theme.colors.button.primary.background : theme.colors.surfaceHigh,
                        }}
                    >
                        <Text style={{
                            color: provider === value ? theme.colors.button.primary.tint : theme.colors.text,
                            textTransform: 'capitalize',
                            ...Typography.default('semiBold'),
                        }}>
                            {value}
                        </Text>
                    </Pressable>
                ))}
            </View>

            <View style={{ flexDirection: 'row', gap: 8 }}>
                <View style={{
                    flex: 1,
                    minHeight: 44,
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 8,
                    paddingHorizontal: 12,
                    borderRadius: 8,
                    borderWidth: 1,
                    borderColor: theme.colors.divider,
                    backgroundColor: theme.colors.surface,
                }}>
                    <Ionicons name="search-outline" size={18} color={theme.colors.textSecondary} />
                    <TextInput
                        value={query}
                        onChangeText={setQuery}
                        accessibilityLabel="Search skills"
                        placeholder="Search skills"
                        placeholderTextColor={theme.colors.textSecondary}
                        style={{ flex: 1, height: 44, color: theme.colors.text, fontSize: theme.typography.body.fontSize, outlineStyle: 'none' } as any}
                    />
                </View>
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Refresh CLI skills"
                    disabled={!isOnline || refreshing}
                    onPress={refresh}
                    style={{
                        width: 44,
                        height: 44,
                        alignItems: 'center',
                        justifyContent: 'center',
                        borderRadius: 8,
                        backgroundColor: theme.colors.surfaceHigh,
                        opacity: isOnline ? 1 : 0.45,
                    }}
                >
                    {refreshing
                        ? <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                        : <Ionicons name="refresh-outline" size={20} color={theme.colors.text} />}
                </Pressable>
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Create ${provider} skill`}
                    disabled={!isOnline}
                    onPress={() => openSkill()}
                    style={{
                        minWidth: 98,
                        height: 44,
                        paddingHorizontal: 14,
                        flexDirection: 'row',
                        gap: 7,
                        alignItems: 'center',
                        justifyContent: 'center',
                        borderRadius: 8,
                        backgroundColor: theme.colors.button.primary.background,
                        opacity: isOnline ? 1 : 0.45,
                    }}
                >
                    <Ionicons name="add" size={18} color={theme.colors.button.primary.tint} />
                    <Text style={{ color: theme.colors.button.primary.tint, ...Typography.default('semiBold') }}>Create</Text>
                </Pressable>
            </View>

            <Text style={{ fontSize: theme.typography.caption.fontSize, color: theme.colors.textSecondary }}>
                {catalog?.version ?? 'CLI not detected'} / {skills.length} skill{skills.length === 1 ? '' : 's'}
                {provider === 'claude' ? ' / built-in skills are read-only' : ''}
            </Text>
        </View>
    );

    return (
        <FlatList
            data={skills}
            keyExtractor={(skill) => `${skill.path ?? provider}:${skill.name}`}
            ListHeaderComponent={header}
            ListEmptyComponent={
                <View style={{ paddingHorizontal: 16, paddingVertical: 40, alignItems: 'center' }}>
                    <Text style={{ color: theme.colors.textSecondary }}>
                        {selectedMachine ? 'No matching skills in this CLI catalog.' : 'Connect a Hapla machine to load skills.'}
                    </Text>
                </View>
            }
            renderItem={({ item }) => {
                const canToggle = provider === 'codex' && Boolean(item.path) && isOnline;
                const pending = pendingSkill === item.path;
                return (
                    <Pressable
                        accessibilityRole={item.path ? 'button' : undefined}
                        accessibilityLabel={item.path ? `Edit skill ${item.name}` : undefined}
                        onPress={item.path ? () => openSkill(item) : undefined}
                        style={({ pressed }) => ({
                        marginHorizontal: 16,
                        paddingVertical: 13,
                        paddingHorizontal: 14,
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 12,
                        borderTopWidth: 1,
                        borderTopColor: theme.colors.divider,
                        backgroundColor: theme.colors.surface,
                        opacity: pressed ? 0.72 : 1,
                    })}>
                        <View style={{ flex: 1 }}>
                            <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 7 }}>
                                <Text style={{ color: theme.colors.text, fontSize: theme.typography.body.fontSize, ...Typography.default('semiBold') }}>
                                    {item.name}
                                </Text>
                                {item.interactive ? (
                                    <View style={{
                                        minHeight: 24,
                                        flexDirection: 'row',
                                        alignItems: 'center',
                                        gap: 4,
                                        paddingHorizontal: 7,
                                        borderRadius: 6,
                                        backgroundColor: theme.colors.surfaceSelected,
                                    }}>
                                        <Ionicons name="browsers-outline" size={13} color={theme.colors.textLink} />
                                        <Text style={{ color: theme.colors.textLink, fontSize: theme.typography.caption.fontSize, ...Typography.default('semiBold') }}>
                                            Interactive
                                        </Text>
                                    </View>
                                ) : null}
                            </View>
                            <Text style={{ color: theme.colors.textSecondary, fontSize: theme.typography.small.fontSize, lineHeight: theme.typography.small.lineHeight, marginTop: 3 }}>
                                {item.description || item.path || 'No description'}
                            </Text>
                            {item.argumentHint ? (
                                <Text style={{ color: theme.colors.textSecondary, fontSize: theme.typography.code.fontSize, marginTop: 4, ...Typography.mono() }}>
                                    {item.argumentHint}
                                </Text>
                            ) : null}
                            <Text style={{ color: theme.colors.textSecondary, fontSize: theme.typography.caption.fontSize, marginTop: 4 }}>
                                {item.path ? `${item.scope || 'user'} / open source` : 'CLI built-in'}
                            </Text>
                        </View>
                        {pending
                            ? <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                            : (
                                <Switch
                                    value={item.enabled}
                                    disabled={!canToggle}
                                    accessibilityLabel={`${item.enabled ? 'Disable' : 'Enable'} skill ${item.name}`}
                                    onValueChange={(enabled) => void setEnabled(item, enabled)}
                                />
                            )}
                    </Pressable>
                );
            }}
            contentContainerStyle={{
                width: '100%',
                maxWidth: 900,
                alignSelf: 'center',
                paddingBottom: 48,
            }}
            style={{ flex: 1, backgroundColor: theme.colors.surface }}
            initialNumToRender={16}
            maxToRenderPerBatch={12}
            windowSize={7}
            removeClippedSubviews
        />
    );
}
