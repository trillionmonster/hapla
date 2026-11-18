import * as React from 'react';
import { Platform, Pressable, View, useWindowDimensions, type PressableProps } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import { ItemList } from '@/components/ItemList';
import { Text } from '@/components/StyledText';
import {
    getAvailableModels,
    resolveModelCatalog,
    getEffortLevelsForModel,
    getHardcodedPermissionModes,
    type ModelMode,
    type ModeOption,
} from '@/components/modelModeOptions';
import { useAllMachines, useSettingMutable } from '@/sync/storage';
import type { Machine } from '@/sync/storageTypes';
import { isMachineOnline } from '@/utils/machineUtils';
import { t, getCurrentLanguage } from '@/text';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';

type AgentKey = 'claude' | 'codex';

const AGENTS: Array<{ key: AgentKey; name: string; asset: number }> = [
    { key: 'codex', name: 'Codex', asset: require('@/assets/images/icon-gpt.png') },
    { key: 'claude', name: 'Claude Code', asset: require('@/assets/images/icon-claude.png') },
];

function discoveredModels(machine: Machine | undefined, agent: AgentKey) {
    return resolveModelCatalog(agent, machine?.metadata);
}

function machineName(machine: Machine | undefined): string {
    return machine?.metadata?.displayName || machine?.metadata?.host || 'connected machine';
}

const english = {
    intro: 'Choose how new conversations start. You can adjust these settings in each session.',
    agent: 'Agent', model: 'Model', effort: 'Thinking depth', speed: 'Response speed', permissions: 'Permissions',
    cliDefault: 'Environment default', defaultSpeed: 'Default', standard: 'Standard',
    modelHint: 'The model used for new conversations.', effortHint: 'More thinking takes more time.',
    fastHint: 'Fast responds sooner and uses more credits.', fastUnavailable: 'This model uses the default speed when Fast is selected.',
    permissionHint: 'Controls command execution and file changes.',
    manageModels: 'Manage models', modelSource: 'Models from', noCatalog: 'Connect a machine to see available models.',
};
const chinese: typeof english = {
    intro: '选择新对话的起始配置，也可以在会话中单独调整。',
    agent: '默认助手', model: '模型', effort: '思考深度', speed: '响应速度', permissions: '执行权限',
    cliDefault: '跟随环境', defaultSpeed: '默认', standard: '标准',
    modelHint: '新对话使用的模型。', effortHint: '思考越深入，通常需要越久。',
    fastHint: 'Fast 响应更快，会消耗更多额度。', fastUnavailable: '当前模型未提供 Fast，使用时会采用默认速度。',
    permissionHint: '控制命令执行与文件修改。',
    manageModels: '管理模型', modelSource: '模型来自', noCatalog: '连接机器后可选择可用模型。',
};

function PreferenceButton({ style, onFocus, onBlur, ...props }: PressableProps) {
    const [focused, setFocused] = React.useState(false);
    return <Pressable {...props}
        {...(Platform.OS === 'web' && props.accessibilityRole === 'radio' ? {
            onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
                if (props.disabled || event.repeat) return;
                if (event.key === ' ' || event.key === 'Enter') {
                    event.preventDefault();
                    event.currentTarget.click();
                } else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
                    const choices = Array.from(event.currentTarget.parentElement?.children ?? [])
                        .filter((element): element is HTMLElement => element instanceof HTMLElement && element.getAttribute('role') === 'radio');
                    if (choices.length < 2) return;
                    event.preventDefault();
                    const direction = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
                    const next = choices[(choices.indexOf(event.currentTarget) + direction + choices.length) % choices.length];
                    next.focus();
                    next.click();
                }
            },
        } : {})}
        onFocus={event => { setFocused(true); onFocus?.(event); }}
        onBlur={event => { setFocused(false); onBlur?.(event); }}
        style={state => [
            typeof style === 'function' ? style(state) : style,
            state.pressed && styles.pressed,
            focused && Platform.OS === 'web' && styles.focused,
        ]} />;
}

function PreferenceOptions({ options, selected, onSelect }: {
    options: ModeOption[]; selected: string; onSelect: (option: ModeOption) => void;
}) {
    const { theme } = useUnistyles();
    return <View style={styles.options}>
        {options.map(option => <PreferenceButton key={option.key} accessibilityRole="radio"
            accessibilityLabel={option.name} accessibilityState={{ checked: selected === option.key }}
            aria-checked={selected === option.key}
            onPress={() => onSelect(option)} style={[styles.option, selected === option.key && styles.optionSelected]}>
            <View style={styles.optionCopy}>
                <Text style={styles.optionTitle}>{option.name}</Text>
                {!!option.description && <Text style={styles.optionDescription}>{option.description}</Text>}
            </View>
            <Ionicons name={selected === option.key ? 'checkmark-circle' : 'ellipse-outline'} size={18}
                color={selected === option.key ? theme.colors.textLink : theme.colors.textSecondary} />
        </PreferenceButton>)}
    </View>;
}

function PreferenceRow({ title, hint, value, expanded, onPress, children, last }: {
    title: string; hint: string; value: string; expanded: boolean; onPress: () => void; children: React.ReactNode; last?: boolean;
}) {
    const { theme } = useUnistyles();
    return <View style={!last && styles.rowDivider}>
        <View style={styles.row}>
            <View style={styles.rowCopy}>
                <Text style={styles.rowTitle}>{title}</Text>
                <Text style={styles.rowHint}>{hint}</Text>
            </View>
            <PreferenceButton accessibilityRole="button" accessibilityLabel={`${title}: ${value}`} accessibilityState={{ expanded }}
                aria-expanded={expanded}
                onPress={onPress} style={[styles.valueButton, expanded && styles.valueButtonExpanded]}>
                <Text style={styles.value} numberOfLines={1}>{value}</Text>
                <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={15} color={theme.colors.textSecondary} />
            </PreferenceButton>
        </View>
        {expanded && children}
    </View>;
}

export default function NewSessionDefaultsScreen() {
    const { theme } = useUnistyles();
    const { width } = useWindowDimensions();
    const compact = width < 600;
    const copy = getCurrentLanguage().startsWith('zh') ? chinese : english;
    const router = useRouter();
    const machines = useAllMachines({ includeOffline: true });
    const [agent, setAgent] = useSettingMutable('newSessionDefaultAgent');
    const [model, setModel] = useSettingMutable('newSessionDefaultModel');
    const [effort, setEffort] = useSettingMutable('newSessionDefaultEffort');
    const [permissionMode, setPermissionMode] = useSettingMutable('newSessionDefaultPermissionMode');
    const [serviceTier, setServiceTier] = useSettingMutable('newSessionDefaultServiceTier');
    const [expanded, setExpanded] = React.useState<'model' | 'effort' | 'mode' | null>(null);

    const capabilityMachine = React.useMemo(() => (
        machines.find((candidate) => (
            isMachineOnline(candidate)
            && (candidate.metadata?.cliCapabilities?.[agent]?.models?.length ?? 0) > 0
        ))
        ?? machines.find((candidate) => isMachineOnline(candidate))
        ?? machines[0]
    ), [agent, machines]);

    const models = React.useMemo<ModelMode[]>(() => getAvailableModels(agent, {
        models: discoveredModels(capabilityMachine, agent),
    } as any, t), [agent, capabilityMachine]);
    const resolvedModel = models.find((candidate) => candidate.key === model) ?? models[0];
    const effortLevels = React.useMemo(
        () => getEffortLevelsForModel(agent, resolvedModel?.key ?? 'default', models),
        [agent, models, resolvedModel?.key],
    );
    const permissionModes = React.useMemo(
        () => getHardcodedPermissionModes(agent, t),
        [agent],
    );
    const resolvedEffort = effortLevels.find((candidate) => candidate.key === effort) ?? effortLevels[0];
    const resolvedPermissionMode = permissionModes.find((candidate) => candidate.key === permissionMode) ?? permissionModes[0];
    const speedOptions = [
        { key: 'default', name: copy.defaultSpeed },
        { key: 'standard', name: copy.standard },
        { key: 'fast', name: 'Fast' },
    ] as const;
    const supportsFast = resolvedModel?.supportedServiceTiers?.some(tier => tier === 'fast' || tier === 'priority');

    React.useEffect(() => {
        if (!capabilityMachine || models.some((candidate) => candidate.key === model)) return;
        setModel('default');
    }, [capabilityMachine, model, models, setModel]);

    React.useEffect(() => {
        if (effortLevels.some((candidate) => candidate.key === effort)) return;
        setEffort('default');
    }, [effort, effortLevels, setEffort]);

    React.useEffect(() => {
        if (permissionModes.some((candidate) => candidate.key === permissionMode)) return;
        setPermissionMode('default');
    }, [permissionMode, permissionModes, setPermissionMode]);

    const chooseAgent = React.useCallback((next: AgentKey) => {
        setAgent(next);
        setModel('default');
        setEffort('default');
        setPermissionMode('default');
        setExpanded(null);
    }, [setAgent, setEffort, setModel, setPermissionMode]);

    const chooseModel = React.useCallback((next: ModelMode) => {
        setModel(next.key);
        if (next.key === 'default' || !next.supportedEffortLevels?.includes(effort)) {
            setEffort('default');
        }
    }, [effort, setEffort, setModel]);

    return (
        <ItemList containerStyle={styles.scrollContent}>
            <View style={[styles.content, compact && styles.contentCompact]}>
                <Text style={styles.intro}>{copy.intro}</Text>
                <View style={styles.agentSection}>
                    <Text style={styles.sectionTitle}>{copy.agent}</Text>
                    <View style={styles.segments} accessibilityLabel={copy.agent}>
                        {AGENTS.map(candidate => <PreferenceButton key={candidate.key} accessibilityRole="radio"
                            accessibilityLabel={candidate.name} accessibilityState={{ checked: agent === candidate.key }}
                            aria-checked={agent === candidate.key}
                            onPress={() => chooseAgent(candidate.key)} style={[styles.agentChoice, agent === candidate.key && styles.segmentSelected]}>
                            <Image source={candidate.asset} style={{ width: 22, height: 22 }} contentFit="contain"
                                tintColor={candidate.key === 'codex' ? theme.colors.text : undefined} />
                            <Text style={[styles.segmentText, agent === candidate.key && styles.segmentTextSelected]}>{candidate.name}</Text>
                        </PreferenceButton>)}
                    </View>
                </View>

                <View style={styles.preferences}>
                    <PreferenceRow title={copy.model} hint={copy.modelHint}
                        value={resolvedModel?.key === 'default' ? copy.cliDefault : resolvedModel?.name ?? copy.cliDefault}
                        expanded={expanded === 'model'} onPress={() => setExpanded(value => value === 'model' ? null : 'model')}>
                        <PreferenceOptions options={models.map(option => option.key === 'default' ? { ...option, name: copy.cliDefault, description: undefined } : option)}
                            selected={resolvedModel?.key ?? 'default'} onSelect={option => { chooseModel(option as ModelMode); setExpanded(null); }} />
                    </PreferenceRow>

                    <PreferenceRow title={copy.effort} hint={copy.effortHint}
                        value={resolvedEffort?.key === 'default' ? copy.cliDefault : resolvedEffort?.name ?? copy.cliDefault}
                        expanded={expanded === 'effort'} onPress={() => setExpanded(value => value === 'effort' ? null : 'effort')}>
                        <PreferenceOptions options={effortLevels.map(option => option.key === 'default' ? { ...option, name: copy.cliDefault, description: undefined } : option)}
                            selected={effort} onSelect={option => { setEffort(option.key); setExpanded(null); }} />
                    </PreferenceRow>

                    {agent === 'codex' && <View style={styles.rowDivider}>
                        <View style={[styles.speedRow, compact && styles.speedRowCompact]}>
                            <View style={styles.rowCopy}>
                                <Text style={styles.rowTitle}>{copy.speed}</Text>
                                <Text style={styles.rowHint}>{supportsFast ? copy.fastHint : copy.fastUnavailable}</Text>
                            </View>
                            <View style={[styles.segments, styles.speedSegments, compact && styles.speedSegmentsCompact]} accessibilityLabel={copy.speed}>
                                {speedOptions.map(option => <PreferenceButton key={option.key} accessibilityRole="radio"
                                    accessibilityLabel={option.name} accessibilityState={{ checked: serviceTier === option.key }}
                                    aria-checked={serviceTier === option.key}
                                    onPress={() => setServiceTier(option.key)} style={[styles.speedChoice, serviceTier === option.key && styles.segmentSelected]}>
                                    {option.key === 'fast' && <Ionicons name="flash-outline" size={14}
                                        color={serviceTier === 'fast' ? theme.colors.textLink : theme.colors.textSecondary} />}
                                    <Text style={[styles.segmentText, serviceTier === option.key && styles.segmentTextSelected]}>{option.name}</Text>
                                </PreferenceButton>)}
                            </View>
                        </View>
                    </View>}

                    <PreferenceRow title={copy.permissions} hint={copy.permissionHint}
                        value={resolvedPermissionMode?.key === 'default' ? copy.cliDefault : resolvedPermissionMode?.name ?? copy.cliDefault}
                        expanded={expanded === 'mode'} onPress={() => setExpanded(value => value === 'mode' ? null : 'mode')} last>
                        <PreferenceOptions options={permissionModes.map(option => option.key === 'default' ? { ...option, name: copy.cliDefault } : option)}
                            selected={permissionMode} onSelect={option => { setPermissionMode(option.key); setExpanded(null); }} />
                    </PreferenceRow>
                </View>

                <View style={styles.catalogFooter}>
                    <Text style={styles.catalogNote}>{capabilityMachine ? `${copy.modelSource} ${machineName(capabilityMachine)}` : copy.noCatalog}</Text>
                    {agent === 'codex' && capabilityMachine && <PreferenceButton accessibilityRole="button" accessibilityLabel={copy.manageModels}
                        onPress={() => router.push(`/machine/${capabilityMachine.id}`)} style={styles.manageButton}>
                        <Text style={styles.manageText}>{copy.manageModels}</Text>
                        <Ionicons name="arrow-forward" size={14} color={theme.colors.textLink} />
                    </PreferenceButton>}
                </View>
            </View>
        </ItemList>
    );
}

// One panel, inset segments, and plain option rows use the existing theme.
// Panel / selector / option radii follow 16 / 12 / 8px respectively.
const styles = StyleSheet.create(theme => ({
    scrollContent: { alignItems: 'center', paddingBottom: 32 },
    content: { width: '100%', maxWidth: 760, paddingHorizontal: 32, paddingTop: 28 },
    contentCompact: { paddingHorizontal: 16, paddingTop: 20 },
    intro: { fontSize: theme.typography.label.fontSize, lineHeight: theme.typography.label.lineHeight, color: theme.colors.textSecondary, marginBottom: 24 },
    agentSection: { marginBottom: 24 },
    sectionTitle: { fontSize: theme.typography.label.fontSize, lineHeight: theme.typography.label.lineHeight, color: theme.colors.text, fontWeight: '600', marginBottom: 10 },
    segments: { flexDirection: 'row', gap: 4, padding: 4, borderRadius: 12, backgroundColor: theme.colors.surfaceHighest },
    agentChoice: { flex: 1, minWidth: 0, minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9, borderRadius: 8 },
    segmentSelected: { backgroundColor: theme.colors.surface },
    segmentText: { fontSize: theme.typography.small.fontSize, lineHeight: theme.typography.small.lineHeight, color: theme.colors.textSecondary },
    segmentTextSelected: { color: theme.colors.text, fontWeight: '600' },
    preferences: { borderWidth: 1, borderColor: theme.colors.divider, borderRadius: 16, backgroundColor: theme.colors.surface, overflow: 'visible' },
    rowDivider: { borderBottomWidth: 1, borderBottomColor: theme.colors.divider },
    row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 18, paddingVertical: 18 },
    rowCopy: { flex: 1, minWidth: 0 },
    rowTitle: { fontSize: theme.typography.label.fontSize, lineHeight: theme.typography.label.lineHeight, fontWeight: '600', color: theme.colors.text },
    rowHint: { fontSize: theme.typography.caption.fontSize, lineHeight: theme.typography.caption.lineHeight, color: theme.colors.textSecondary, marginTop: 4 },
    valueButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 7, maxWidth: '52%', minHeight: 44, paddingHorizontal: 10, borderRadius: 8 },
    valueButtonExpanded: { backgroundColor: theme.colors.surfaceHigh },
    value: { flexShrink: 1, fontSize: theme.typography.small.fontSize, lineHeight: theme.typography.small.lineHeight, color: theme.colors.text },
    options: { paddingHorizontal: 8, paddingBottom: 8, gap: 3 },
    option: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 48, padding: 12, borderRadius: 8 },
    optionSelected: { backgroundColor: theme.colors.surfaceHigh },
    optionCopy: { flex: 1, minWidth: 0 },
    optionTitle: { fontSize: theme.typography.label.fontSize, lineHeight: theme.typography.label.lineHeight, color: theme.colors.text },
    optionDescription: { marginTop: 3, fontSize: theme.typography.caption.fontSize, lineHeight: theme.typography.caption.lineHeight, color: theme.colors.textSecondary },
    speedRow: { flexDirection: 'row', alignItems: 'center', gap: 20, padding: 18 },
    speedRowCompact: { flexDirection: 'column', alignItems: 'stretch', gap: 12 },
    speedSegments: { flexShrink: 0, width: 280 },
    speedSegmentsCompact: { width: '100%' },
    speedChoice: { flex: 1, minWidth: 0, minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, borderRadius: 8 },
    catalogFooter: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, paddingTop: 12, paddingHorizontal: 4 },
    catalogNote: { flex: 1, minWidth: 160, fontSize: theme.typography.caption.fontSize, lineHeight: theme.typography.caption.lineHeight, color: theme.colors.textSecondary },
    manageButton: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 6, borderRadius: 8 },
    manageText: { fontSize: theme.typography.caption.fontSize, lineHeight: theme.typography.caption.lineHeight, color: theme.colors.text },
    pressed: { backgroundColor: theme.colors.surfacePressed },
    focused: { outlineColor: theme.colors.textLink, outlineWidth: 2, outlineOffset: 2, outlineStyle: 'solid' },
}));
