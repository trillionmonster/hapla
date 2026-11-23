import React from 'react';
import { useIsFocused } from '@react-navigation/native';
import {
    View,
    Text,
    Platform,
    Pressable,
    Modal as RNModal,
    TouchableWithoutFeedback,
    Animated,
    TextInput,
    ScrollView,
    LayoutAnimation,
    ActivityIndicator,
    Image as RNImage,
    useWindowDimensions,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import Ionicons from '@expo/vector-icons/Ionicons';
import Octicons from '@expo/vector-icons/Octicons';
import { useRouter } from 'expo-router';
import { Typography } from '@/constants/Typography';
import { layout } from '@/components/layout';
import {
    MultiTextInput,
    type KeyPressEvent,
} from '@/components/MultiTextInput';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import Constants from 'expo-constants';
import { useHeaderHeight } from '@/utils/responsive';
import { t } from '@/text';
import { useAllMachines, useSessions, useSetting, useIsDataReady, storage } from '@/sync/storage';
import type { NewSessionAgentType } from '@/sync/persistence';
import { sync } from '@/sync/sync';
import { isMachineOnline } from '@/utils/machineUtils';
import { machineSpawnNewSession } from '@/sync/ops';
import { WorkspaceDirectoryPicker } from '@/components/WorkspaceDirectoryPicker';
import { createWorktree, listWorktrees } from '@/utils/worktree';
import { resolveAbsolutePath } from '@/utils/pathUtils';
import { formatPathRelativeToHome, formatLastSeen } from '@/utils/sessionUtils';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { useNewSessionDraft } from '@/hooks/useNewSessionDraft';
import { Modal } from '@/modal';
import { VoiceInput, VoiceInputStatus, type VoiceInputFeedback } from '@/components/OptionalVoiceInput';
import { CodexControls } from '@/components/CodexControls';
import { defaultCodexPreferences, type CodexPreferences } from '@/sync/codexPreferences';
import { useWorkspaceAttachments } from '@/hooks/useWorkspaceAttachments';
import { attachmentMessage } from '@/utils/workspaceAttachments';
import { resolvePreferredMachineId } from '@/utils/machineSelection';
import {
    getWebImageFailureMessage,
    prepareWebImagesForUpload,
    readWebImageFiles,
    WEB_IMAGE_INPUT_ACCEPT,
} from '@/utils/webImageUpload';
import type { Machine, Session } from '@/sync/storageTypes';
import {
    getHardcodedPermissionModes,
    getAvailableModels,
    resolveModelCatalog,
    getEffortLevelsForModel,
    getDefaultEffortKeyForModel,
    getDefaultPermissionModeKey,
    getDefaultModelKey,
    getSupportsWorktree,
    type PermissionMode,
    type ModelMode,
    type EffortLevel,
} from '@/components/modelModeOptions';
import { isRunningOnMac } from '@/utils/platform';

// Agent icon assets
const agentIcons = {
    claude: require('@/assets/images/icon-claude.png'),
    codex: require('@/assets/images/icon-gpt.png'),
};

type AgentKey = NewSessionAgentType;
const ALL_AGENTS: { key: AgentKey; label: string }[] = [
    { key: 'claude', label: 'claude code' },
    { key: 'codex', label: 'codex' },
];

type PickerItem = { key: string; label: string; subtitle?: string; dimmed?: boolean };

type PickerType = 'machine' | 'path' | 'worktree';

type PermissionStyle = { color: string; icon: 'play-forward' | 'pause' };
type PastedImage = { data: string; mediaType: string; previewData?: string; sourceFile?: File };

const COMPOSER_INPUT_VERTICAL_PADDING = Platform.OS === 'web' ? 10 : 8;
const COMPOSER_SEND_BUTTON_SIZE = 32;
const WORKTREE_PATH_DEBOUNCE_MS = 300;

function trimPathInput(path: string | null | undefined): string {
    return path?.trim() ?? '';
}

function trimTrailingPathSeparator(path: string): string {
    if (path === '/' || /^[A-Za-z]:[\\/]?$/.test(path)) {
        return path;
    }
    return path.replace(/[\\/]+$/, '');
}

function normalizePathForComparison(path: string | null | undefined, homeDir?: string): string | null {
    const trimmed = trimPathInput(path);
    if (!trimmed) {
        return null;
    }
    return trimTrailingPathSeparator(resolveAbsolutePath(trimmed, homeDir));
}

function getPermissionStyle(key: string): PermissionStyle | null {
    switch (key) {
        case 'acceptEdits':
        case 'auto_edit':
            return { color: '#A78BFA', icon: 'play-forward' };
        case 'plan':
            return { color: '#5EABA4', icon: 'pause' };
        case 'dontAsk':
        case 'safe-yolo':
            return { color: '#FBBF24', icon: 'play-forward' };
        case 'bypassPermissions':
        case 'yolo':
            return { color: '#F87171', icon: 'play-forward' };
        case 'read-only':
            return { color: '#60A5FA', icon: 'pause' };
        default:
            return null;
    }
}

// Bottom sheet modal — native formSheet on iOS, slide-up sheet on Android
function BottomSheet({
    visible,
    onClose,
    children,
}: {
    visible: boolean;
    onClose: () => void;
    children: React.ReactNode;
}) {
    const { theme } = useUnistyles();
    const safeArea = useSafeAreaInsets();

    if (Platform.OS === 'ios') {
        return (
            <RNModal
                visible={visible}
                animationType="slide"
                presentationStyle="formSheet"
                onRequestClose={onClose}
            >
                <View style={[sheetStyles.iosContainer, { backgroundColor: theme.colors.header.background }]}>
                    <View style={sheetStyles.handleRow}>
                        <View style={[sheetStyles.handle, { backgroundColor: theme.colors.textSecondary }]} />
                    </View>
                    {children}
                    <View style={{ height: safeArea.bottom }} />
                </View>
            </RNModal>
        );
    }

    // Android: slide-up sheet with backdrop
    const fadeAnim = React.useRef(new Animated.Value(0)).current;
    const slideAnim = React.useRef(new Animated.Value(300)).current;

    React.useEffect(() => {
        if (visible) {
            Animated.parallel([
                Animated.timing(fadeAnim, { toValue: 1, duration: 250, useNativeDriver: true }),
                Animated.spring(slideAnim, { toValue: 0, damping: 25, stiffness: 300, useNativeDriver: true }),
            ]).start();
        } else {
            Animated.parallel([
                Animated.timing(fadeAnim, { toValue: 0, duration: 200, useNativeDriver: true }),
                Animated.timing(slideAnim, { toValue: 300, duration: 200, useNativeDriver: true }),
            ]).start();
        }
    }, [visible, fadeAnim, slideAnim]);

    return (
        <RNModal
            visible={visible}
            transparent
            animationType="none"
            onRequestClose={onClose}
        >
            <View style={sheetStyles.overlay}>
                <TouchableWithoutFeedback onPress={onClose}>
                    <Animated.View style={[sheetStyles.backdrop, { opacity: fadeAnim }]} />
                </TouchableWithoutFeedback>
                <Animated.View
                    style={[
                        sheetStyles.sheet,
                        {
                            backgroundColor: theme.colors.header.background,
                            paddingBottom: Math.max(16, safeArea.bottom),
                            transform: [{ translateY: slideAnim }],
                        },
                    ]}
                >
                    <View style={sheetStyles.handleRow}>
                        <View style={[sheetStyles.handle, { backgroundColor: theme.colors.textSecondary }]} />
                    </View>
                    {children}
                </Animated.View>
            </View>
        </RNModal>
    );
}

// Generic picker content — reused for machine, path, and worktree selection
function PickerContent({
    title,
    fixedItems,
    items,
    selectedKey,
    onSelect,
    searchPlaceholder,
}: {
    title: string;
    fixedItems?: PickerItem[];
    items: PickerItem[];
    selectedKey: string | null;
    onSelect: (key: string) => void;
    searchPlaceholder?: string;
}) {
    const { theme } = useUnistyles();
    const [search, setSearch] = React.useState('');

    const filtered = React.useMemo(() => {
        if (!search) return items;
        const q = search.toLowerCase();
        return items.filter(item => item.label.toLowerCase().includes(q));
    }, [search, items]);

    const renderOption = (item: PickerItem) => {
        const isSelected = item.key === selectedKey;
        return (
            <Pressable
                key={item.key}
                style={(p) => [pickerStyles.option, p.pressed && pickerStyles.optionPressed, item.dimmed && { opacity: 0.45 }]}
                onPress={() => onSelect(item.key)}
            >
                <Octicons
                    name={isSelected ? 'check-circle-fill' : 'circle'}
                    size={16}
                    color={isSelected ? theme.colors.button.primary.background : theme.colors.textSecondary}
                />
                <View style={{ flex: 1 }}>
                    <Text style={[pickerStyles.optionText, { color: theme.colors.text }]}>{item.label}</Text>
                    {item.subtitle && (
                        <Text style={[pickerStyles.optionText, { color: theme.colors.textSecondary, fontSize: theme.typography.small.fontSize }]}>{item.subtitle}</Text>
                    )}
                </View>
            </Pressable>
        );
    };

    return (
        <View style={pickerStyles.container}>
            <Text style={[pickerStyles.title, { color: theme.colors.text }]}>{title}</Text>

            <View style={[pickerStyles.searchRow, { backgroundColor: theme.colors.input.background }]}>
                <Ionicons name="search" size={16} color={theme.colors.textSecondary} />
                <TextInput
                    value={search}
                    onChangeText={setSearch}
                    placeholder={searchPlaceholder ?? 'search...'}
                    placeholderTextColor={theme.colors.textSecondary}
                    style={[pickerStyles.searchInput, { color: theme.colors.text }]}
                    autoCapitalize="none"
                    autoCorrect={false}
                />
            </View>

            <ScrollView style={pickerStyles.optionList} keyboardShouldPersistTaps="handled">
                {fixedItems?.map(renderOption)}
                {fixedItems && fixedItems.length > 0 && filtered.length > 0 && (
                    <View style={[pickerStyles.divider, { backgroundColor: theme.colors.divider }]} />
                )}
                {filtered.map(renderOption)}
                {filtered.length === 0 && search.length > 0 && (
                    <Text style={[pickerStyles.emptyText, { color: theme.colors.textSecondary }]}>
                        no results
                    </Text>
                )}
            </ScrollView>
        </View>
    );
}

// Helper: get machine display name
function getMachineName(machine: Machine): string {
    return machine.metadata?.displayName || machine.metadata?.host || 'unknown';
}

type EnvironmentRow = { id: string; key: string; value: string };

function EnvironmentVariablesEditor(props: {
    rows: EnvironmentRow[];
    onChange: (rows: EnvironmentRow[]) => void;
}) {
    const { theme } = useUnistyles();
    const compact = Platform.OS === 'web' && useWindowDimensions().width <= 700;
    const [revealValues, setRevealValues] = React.useState(false);

    const updateRow = (id: string, field: 'key' | 'value', value: string) => {
        props.onChange(props.rows.map((row) => row.id === id ? { ...row, [field]: value } : row));
    };

    return (
        <View style={styles.envEditor}>
            <View style={styles.envHeader}>
                <View style={{ flex: 1 }}>
                    <Text style={[styles.envTitle, { color: theme.colors.text }]}>Environment variables</Text>
                    <Text style={[styles.envHint, { color: theme.colors.textSecondary }]}>
                        Passed only to the new CLI process. Names are remembered; secret values are never persisted.
                    </Text>
                </View>
                <Pressable
                    accessibilityLabel={revealValues ? 'Hide environment values' : 'Show environment values'}
                    onPress={() => setRevealValues((value) => !value)}
                    style={[styles.envIconButton, compact && { width: 44, height: 44 }]}
                >
                    <Ionicons
                        name={revealValues ? 'eye-off-outline' : 'eye-outline'}
                        size={17}
                        color={theme.colors.textSecondary}
                    />
                </Pressable>
            </View>

            {props.rows.map((row) => (
                <View key={row.id} style={[styles.envRow, compact && { flexDirection: 'column', alignItems: 'stretch', gap: 7 }]}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                        <TextInput
                            value={row.key}
                            onChangeText={(value) => updateRow(row.id, 'key', value.toUpperCase())}
                            placeholder="OPENAI_BASE_URL"
                            placeholderTextColor={theme.colors.textSecondary}
                            autoCapitalize="characters"
                            autoCorrect={false}
                            style={[styles.envInput, styles.envKeyInput, compact && { minHeight: 44 }, { color: theme.colors.text, borderColor: theme.colors.divider }]}
                        />
                        {compact ? (
                            <Pressable
                                accessibilityLabel={`Remove ${row.key || 'environment variable'}`}
                                onPress={() => props.onChange(props.rows.filter((candidate) => candidate.id !== row.id))}
                                style={[styles.envIconButton, { width: 44, height: 44 }]}
                            >
                                <Ionicons name="trash-outline" size={17} color={theme.colors.textSecondary} />
                            </Pressable>
                        ) : null}
                    </View>
                    <TextInput
                        value={row.value}
                        onChangeText={(value) => updateRow(row.id, 'value', value)}
                        placeholder="value"
                        placeholderTextColor={theme.colors.textSecondary}
                        autoCapitalize="none"
                        autoCorrect={false}
                        secureTextEntry={!revealValues}
                        style={[styles.envInput, compact && { minHeight: 44 }, { color: theme.colors.text, borderColor: theme.colors.divider }]}
                    />
                    {compact ? null : (
                        <Pressable
                            accessibilityLabel={`Remove ${row.key || 'environment variable'}`}
                            onPress={() => props.onChange(props.rows.filter((candidate) => candidate.id !== row.id))}
                            style={styles.envIconButton}
                        >
                            <Ionicons name="trash-outline" size={16} color={theme.colors.textSecondary} />
                        </Pressable>
                    )}
                </View>
            ))}

            <Pressable
                accessibilityRole="button"
                accessibilityLabel="Add environment variable"
                onPress={() => props.onChange([
                    ...props.rows,
                    { id: `env-${Date.now()}-${props.rows.length}`, key: '', value: '' },
                ])}
                style={(state) => [styles.envAddButton, compact && { minHeight: 44, paddingHorizontal: 8 }, state.pressed && styles.configRowPressed]}
            >
                <Ionicons name="add" size={16} color={theme.colors.button.secondary.tint} />
                <Text style={[styles.envAddLabel, { color: theme.colors.button.secondary.tint }]}>Add variable</Text>
            </Pressable>
        </View>
    );
}

function NewSessionScreen() {
    const { theme } = useUnistyles();
    const safeArea = useSafeAreaInsets();
    const headerHeight = useHeaderHeight();
    const router = useRouter();
    const navigateToSession = useNavigateToSession();
    const screenWidth = useWindowDimensions().width;

    // Real data sources
    const allMachines = useAllMachines({ includeOffline: true });
    const sessions = useSessions();
    const isDataReady = useIsDataReady();
    const agentInputEnterToSend = useSetting('agentInputEnterToSend');
    const newSessionDefaultAgent = useSetting('newSessionDefaultAgent');
    const newSessionDefaultModel = useSetting('newSessionDefaultModel');
    const newSessionDefaultEffort = useSetting('newSessionDefaultEffort');
    const newSessionDefaultPermissionMode = useSetting('newSessionDefaultPermissionMode');
    const newSessionDefaultServiceTier = useSetting('newSessionDefaultServiceTier');
    const [codexPreferences, setCodexPreferences] = React.useState<CodexPreferences>(() => ({
        ...defaultCodexPreferences, serviceTier: newSessionDefaultServiceTier,
    }));

    // Persisted draft state (survives navigation)
    const draft = useNewSessionDraft();
    const prompt = draft.input;
    const setPrompt = draft.setInput;
    const selectedAgent = draft.agentType;
    const setSelectedAgent = draft.setAgentType;
    const selectedMachineId = draft.selectedMachineId;
    const setSelectedMachineId = draft.setMachineId;
    const selectedPath = draft.selectedPath;
    const setSelectedPath = draft.setPath;
    const defaultsAppliedRef = React.useRef(false);
    React.useEffect(() => {
        if (!isDataReady || defaultsAppliedRef.current) return;
        defaultsAppliedRef.current = true;
        setSelectedAgent(newSessionDefaultAgent);
        draft.setModelMode(newSessionDefaultModel);
        draft.setEffortLevel(newSessionDefaultEffort);
        draft.setPermissionMode(newSessionDefaultPermissionMode);
        setCodexPreferences({ ...defaultCodexPreferences, serviceTier: newSessionDefaultServiceTier });
    }, [
        draft.setEffortLevel,
        draft.setModelMode,
        draft.setPermissionMode,
        isDataReady,
        newSessionDefaultAgent,
        newSessionDefaultEffort,
        newSessionDefaultModel,
        newSessionDefaultPermissionMode,
        newSessionDefaultServiceTier,
        setSelectedAgent,
    ]);
    const [worktreeKey, setWorktreeKey] = React.useState<string>(
        draft.worktreeKey ?? (draft.sessionType === 'worktree' ? '__new__' : '__none__')
    );
    React.useEffect(() => {
        draft.setSessionType(worktreeKey !== '__none__' ? 'worktree' : 'simple');
        draft.setWorktreeKey(worktreeKey === '__none__' || worktreeKey === '__new__' ? null : worktreeKey);
    }, [worktreeKey]);

    // Local-only UI state (not persisted)
    const [permissionIndex, setPermissionIndex] = React.useState(0);
    const [modelIndex, setModelIndex] = React.useState(0);
    const [effortIndex, setEffortIndex] = React.useState(0);
    const [isSpawning, setIsSpawning] = React.useState(false);
    const [voiceBusy, setVoiceBusy] = React.useState(false);
    const [voiceFeedback, setVoiceFeedback] = React.useState<VoiceInputFeedback | null>(null);
    const [showReplySettings, setShowReplySettings] = React.useState(false);
    const [activePicker, setActivePicker] = React.useState<PickerType | null>(null);
    const [pastedImages, setPastedImages] = React.useState<PastedImage[]>([]);
    const [environmentRows, setEnvironmentRowsState] = React.useState<EnvironmentRow[]>(() => (
        Object.entries(draft.environmentVariables).map(([key, value], index) => ({
            id: `env-initial-${index}`,
            key,
            value,
        }))
    ));
    const setEnvironmentRows = React.useCallback((rows: EnvironmentRow[]) => {
        setEnvironmentRowsState(rows);
        draft.setEnvironmentVariables(Object.fromEntries(
            rows
                .map((row) => [row.key.trim(), row.value] as const)
                .filter(([key]) => key.length > 0),
        ));
    }, [draft.setEnvironmentVariables]);
    const environmentVariables = React.useMemo(() => Object.fromEntries(
        environmentRows
            .map((row) => [row.key.trim(), row.value] as const)
            .filter(([key]) => key.length > 0),
    ), [environmentRows]);

    const isMobileWeb = Platform.OS === 'web' && screenWidth <= 700;
    const RootKeyboardView = Platform.OS === 'web' ? View : KeyboardAvoidingView;
    const showProminentMobileWebImageButton = false;
    const webFileInputRef = React.useRef<HTMLInputElement | null>(null);

    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
        if (typeof document === 'undefined') return;
        if (webFileInputRef.current) return;

        const input = document.createElement('input');
        input.type = 'file';
        input.accept = WEB_IMAGE_INPUT_ACCEPT;
        input.multiple = true;
        input.tabIndex = -1;
        input.style.position = 'fixed';
        input.style.left = '-9999px';
        input.style.top = '0';
        input.style.width = '1px';
        input.style.height = '1px';
        input.style.opacity = '0';
        input.style.pointerEvents = 'none';
        document.body.appendChild(input);
        webFileInputRef.current = input;

        return () => {
            if (input.parentNode) {
                input.parentNode.removeChild(input);
            }
            webFileInputRef.current = null;
        };
    }, []);

    // Config collapse — auto-collapses when typing, expands when empty
    const [isConfigExpanded, setIsConfigExpanded] = React.useState(true);

    // Auto-select a usable machine when none is selected or the draft points at a stale machine.
    React.useEffect(() => {
        const preferredMachineId = resolvePreferredMachineId(allMachines, selectedMachineId);
        if (!preferredMachineId || preferredMachineId === selectedMachineId) {
            return;
        }
        setSelectedPath(null);
        setSelectedMachineId(preferredMachineId);
    }, [allMachines, selectedMachineId, setSelectedMachineId, setSelectedPath]);

    const selectedMachine = React.useMemo(
        () => allMachines.find(m => m.id === selectedMachineId) ?? null,
        [allMachines, selectedMachineId],
    );
    const selectedHomeDir = selectedMachine?.metadata?.homeDir;

    // Build machine picker items: online first, then offline
    const machineItems = React.useMemo<PickerItem[]>(() => {
        const sorted = [...allMachines].sort((a, b) => {
            const aOnline = isMachineOnline(a) ? 0 : 1;
            const bOnline = isMachineOnline(b) ? 0 : 1;
            return aOnline - bOnline;
        });
        return sorted.map(m => ({
            key: m.id,
            label: getMachineName(m),
            subtitle: isMachineOnline(m) ? t('status.online') : t('status.lastSeen', { time: formatLastSeen(m.activeAt, false) }),
            dimmed: !isMachineOnline(m),
        }));
    }, [allMachines]);

    // Build path items from session history for selected machine
    const pathItems = React.useMemo<PickerItem[]>(() => {
        if (!selectedMachineId || !sessions) return [];
        const paths = new Set<string>();
        for (const s of sessions) {
            if (typeof s === 'string') continue;
            const session = s as Session;
            if (session.metadata?.machineId === selectedMachineId && session.metadata?.path) {
                paths.add(session.metadata.path);
            }
        }
        const homeDir = selectedMachine?.metadata?.homeDir;
        return Array.from(paths).sort().map(p => ({
            key: p,
            label: formatPathRelativeToHome(p, homeDir),
        }));
    }, [selectedMachineId, sessions, selectedMachine]);

    // Auto-select first path when machine changes
    React.useEffect(() => {
        if (!selectedMachineId || selectedPath !== null) {
            return;
        }

        setSelectedPath(pathItems[0]?.label ?? '~');
    }, [selectedMachineId, pathItems, selectedPath, setSelectedPath]);

    const resolvedSelectedPath = React.useMemo(() => {
        return normalizePathForComparison(selectedPath, selectedHomeDir);
    }, [selectedHomeDir, selectedPath]);

    const [debouncedResolvedSelectedPath, setDebouncedResolvedSelectedPath] = React.useState<string | null>(resolvedSelectedPath);

    React.useEffect(() => {
        if (!resolvedSelectedPath) {
            setDebouncedResolvedSelectedPath(null);
            return;
        }

        const timeout = setTimeout(() => {
            setDebouncedResolvedSelectedPath(resolvedSelectedPath);
        }, WORKTREE_PATH_DEBOUNCE_MS);

        return () => clearTimeout(timeout);
    }, [resolvedSelectedPath]);

    // Fetch existing worktrees from the selected machine/path
    const [worktreeItems, setWorktreeItems] = React.useState<PickerItem[]>([]);
    React.useEffect(() => {
        if (!selectedMachineId || !debouncedResolvedSelectedPath) {
            setWorktreeItems([]);
            return;
        }
        if (!selectedMachine || !isMachineOnline(selectedMachine)) {
            setWorktreeItems([]);
            return;
        }
        let cancelled = false;
        listWorktrees(selectedMachineId, debouncedResolvedSelectedPath).then(worktrees => {
            if (cancelled) return;
            setWorktreeItems(worktrees.map(wt => ({
                key: wt.path,
                label: wt.branch,
                subtitle: wt.path,
            })));
        });
        return () => { cancelled = true; };
    }, [debouncedResolvedSelectedPath, selectedMachineId, selectedMachine]);

    React.useEffect(() => {
        if (worktreeKey === '__none__' || worktreeKey === '__new__') {
            return;
        }

        if (!worktreeItems.some((item) => item.key === worktreeKey)) {
            setWorktreeKey('__none__');
        }
    }, [worktreeItems, worktreeKey]);

    // Filter available agents based on CLI availability from machine metadata
    const availableAgents = React.useMemo(() => {
        const availability = selectedMachine?.metadata?.cliAvailability;
        if (!availability) return ALL_AGENTS;
        return ALL_AGENTS.filter(a => availability[a.key]);
    }, [selectedMachine]);

    // If current agent not available on this machine, switch to first available
    React.useEffect(() => {
        if (availableAgents.length > 0 && !availableAgents.find(a => a.key === selectedAgent)) {
            setSelectedAgent(availableAgents[0].key);
        }
    }, [availableAgents, selectedAgent, setSelectedAgent]);

    // Derive options from agent type
    const permissionModes = React.useMemo<PermissionMode[]>(
        () => getHardcodedPermissionModes(selectedAgent, t),
        [selectedAgent],
    );
    const modelModes = React.useMemo<ModelMode[]>(
        () => getAvailableModels(selectedAgent, {
            models: resolveModelCatalog(selectedAgent, selectedMachine?.metadata),
        }, t),
        [selectedAgent, selectedMachine?.metadata?.cliCapabilities, selectedMachine?.metadata?.codexModels],
    );

    const currentModel = modelModes[modelIndex] ?? modelModes[0];
    const currentModelKey = currentModel?.key ?? 'default';

    const effortLevels = React.useMemo<EffortLevel[]>(
        () => getEffortLevelsForModel(selectedAgent, currentModelKey, modelModes),
        [selectedAgent, currentModelKey, modelModes],
    );

    const supportsWorktree = getSupportsWorktree(selectedAgent);
    const showModel = modelModes.length > 1;
    const showEffort = effortLevels.length > 0;
    const showPermission = permissionModes.length > 1;

    // Reset indices when agent changes — try draft keys first, then defaults
    React.useEffect(() => {
        const draftPermIdx = permissionModes.findIndex(m => m.key === draft.permissionMode);
        const defaultPermIdx = permissionModes.findIndex(m => m.key === getDefaultPermissionModeKey(selectedAgent));
        setPermissionIndex(draftPermIdx >= 0 ? draftPermIdx : (defaultPermIdx >= 0 ? defaultPermIdx : 0));

        const draftModelIdx = modelModes.findIndex(m => m.key === draft.modelMode);
        const defaultModelIdx = modelModes.findIndex(m => m.key === getDefaultModelKey(selectedAgent));
        setModelIndex(draftModelIdx >= 0 ? draftModelIdx : (defaultModelIdx >= 0 ? defaultModelIdx : 0));

        if (!supportsWorktree) setWorktreeKey('__none__');
    }, [selectedAgent, permissionModes, modelModes, supportsWorktree]);

    // Resolve the configured output level against the selected model's live
    // capability list. Unsupported values fall back without inventing levels.
    React.useEffect(() => {
        const configuredEffort = effortLevels.findIndex(e => e.key === draft.effortLevel);
        if (configuredEffort >= 0) {
            setEffortIndex(configuredEffort);
            return;
        }
        const defaultEffort = getDefaultEffortKeyForModel(selectedAgent, currentModelKey, modelModes);
        if (defaultEffort && effortLevels.length > 0) {
            const idx = effortLevels.findIndex(e => e.key === defaultEffort);
            setEffortIndex(idx >= 0 ? idx : effortLevels.length - 1);
        } else {
            setEffortIndex(0);
        }
    }, [selectedAgent, currentModelKey, draft.effortLevel, effortLevels, modelModes]);

    const hasText = prompt.trim().length > 0;
    const hasImages = pastedImages.length > 0;

    // Auto collapse config once when user starts typing (mobile only)
    // On desktop (web / Mac Catalyst) the panel stays expanded
    // Also skip collapsing on the initial render when draft text is restored
    const hasCollapsedOnceRef = React.useRef(false);
    const isInitialRef = React.useRef(true);
    const isDesktop = Platform.OS === 'web' || isRunningOnMac();
    React.useEffect(() => {
        if (isInitialRef.current) {
            isInitialRef.current = false;
            return;
        }
        if (isDesktop) return;
        if (hasText && !hasCollapsedOnceRef.current) {
            hasCollapsedOnceRef.current = true;
            LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
            setIsConfigExpanded(false);
        }
    }, [hasText]);


    const toggleConfig = React.useCallback(() => {
        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
        setIsConfigExpanded(v => !v);
    }, []);

    const togglePicker = React.useCallback((type: PickerType) => {
        setActivePicker(v => v === type ? null : type);
    }, []);

    const cyclePermission = React.useCallback(() => {
        setPermissionIndex(i => {
            const next = (i + 1) % permissionModes.length;
            draft.setPermissionMode(permissionModes[next]?.key ?? 'default');
            return next;
        });
    }, [permissionModes, draft.setPermissionMode]);

    const cycleModel = React.useCallback(() => {
        setModelIndex(i => {
            const next = (i + 1) % modelModes.length;
            draft.setModelMode(modelModes[next]?.key ?? 'default');
            return next;
        });
    }, [modelModes, draft.setModelMode]);

    const cycleEffort = React.useCallback(() => {
        setEffortIndex(i => {
            const next = (i + 1) % effortLevels.length;
            draft.setEffortLevel(effortLevels[next]?.key ?? 'default');
            return next;
        });
    }, [draft.setEffortLevel, effortLevels]);

    const cycleAgent = React.useCallback(() => {
        const idx = availableAgents.findIndex(a => a.key === selectedAgent);
        const next = availableAgents[(idx + 1) % availableAgents.length].key;
        setSelectedAgent(next);
    }, [availableAgents, selectedAgent, setSelectedAgent]);

    const isOffline = selectedMachine ? !isMachineOnline(selectedMachine) : false;
    const agent = availableAgents.find(a => a.key === selectedAgent) ?? ALL_AGENTS[0];
    const currentPermission = permissionModes[permissionIndex] ?? permissionModes[0];
    const currentEffort = effortLevels[effortIndex] ?? effortLevels[0];
    const attachments = useWorkspaceAttachments({ scope: `new:${selectedMachineId}:${selectedPath}`, active: true, prepareSession: async () => { throw new Error('请创建会话后重试附件上传'); } });
    const permissionStyle = currentPermission?.key !== 'default' ? getPermissionStyle(currentPermission.key) : null;

    // Display values
    const machineName = selectedMachine ? getMachineName(selectedMachine) : 'Select machine';
    const pathName = trimPathInput(selectedPath)
        ? formatPathRelativeToHome(trimPathInput(selectedPath), selectedHomeDir)
        : '~';
    const worktreeLabel = worktreeKey === '__none__'
        ? 'no worktree'
        : worktreeKey === '__new__'
            ? 'new worktree'
            : worktreeItems.find(wt => wt.key === worktreeKey)?.label || worktreeKey;

    // Flash label for collapsed icon taps — shows label briefly above the icon
    const flashOpacity = React.useRef(new Animated.Value(0)).current;
    const [flashText, setFlashText] = React.useState('');
    const flashTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    const showFlash = React.useCallback((text: string) => {
        if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
        setFlashText(text);
        flashOpacity.setValue(0);
        Animated.timing(flashOpacity, { toValue: 1, duration: 120, useNativeDriver: true }).start();
        flashTimerRef.current = setTimeout(() => {
            Animated.timing(flashOpacity, { toValue: 0, duration: 300, useNativeDriver: true }).start();
        }, 800);
    }, [flashOpacity]);

    // Picker data derived from active picker type
    const pickerData = React.useMemo(() => {
        switch (activePicker) {
            case 'machine':
                return { title: 'Machine', items: machineItems, selectedKey: selectedMachineId, searchPlaceholder: 'search machines...' };
            case 'worktree':
                return { title: 'Worktree', fixedItems: WORKTREE_FIXED_ITEMS, items: worktreeItems, selectedKey: worktreeKey, searchPlaceholder: 'search worktrees...' };
            default:
                return null;
        }
    }, [activePicker, machineItems, selectedMachineId, worktreeKey, worktreeItems]);

    const handlePickerSelect = React.useCallback((key: string) => {
        switch (activePicker) {
            case 'machine':
                setSelectedPath(null);
                setWorktreeKey('__none__');
                setSelectedMachineId(key);
                break;
            case 'worktree':
                setWorktreeKey(key);
                break;
        }
        setActivePicker(null);
    }, [activePicker, setSelectedMachineId, setSelectedPath, setWorktreeKey]);

    const handlePickImages = React.useCallback(async () => {
        if (Platform.OS === 'web') {
            const input = webFileInputRef.current;
            if (!input) return;

            input.onchange = async () => {
                const files = input.files ? Array.from(input.files) : [];
                input.value = '';
                if (files.length === 0) return;

                const imageFiles = files.filter((file) => file.type.startsWith('image/'));
                if (imageFiles.length === 0) return;

                const results = await readWebImageFiles(imageFiles);
                const { acceptedImages, rejectedImages } = await prepareWebImagesForUpload(results);

                if (acceptedImages.length > 0) {
                    setPastedImages((prev) => [...prev, ...acceptedImages]);
                }
                if (rejectedImages.length > 0) {
                    console.error('Rejected web images before new-session send:', rejectedImages.map((image) => image.mediaType));
                    Modal.alert(t('common.error'), getWebImageFailureMessage(rejectedImages));
                }
            };

            input.click();
            return;
        }

        const result = await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ['images'],
            allowsMultipleSelection: true,
            base64: true,
            quality: 0.8,
        });
        if (result.canceled || !result.assets) return;

        const images: PastedImage[] = result.assets
            .filter((asset) => asset.base64)
            .map((asset) => ({
                data: asset.base64!,
                mediaType: asset.mimeType ?? 'image/jpeg',
            }));

        if (images.length > 0) {
            setPastedImages((prev) => [...prev, ...images]);
        }
    }, []);

    // Spawn session handler
    const handleSend = React.useCallback(async (approvedNewDirectoryCreation: boolean = false) => {
        if (voiceBusy || isSpawning) return;
        if (!selectedMachineId || !selectedMachine) {
            Modal.alert(t('common.error'), 'Please select a machine');
            return;
        }
        if (!isMachineOnline(selectedMachine)) {
            Modal.alert(t('common.error'), 'Machine is offline');
            return;
        }
        const invalidEnvironmentKey = environmentRows.find(
            (row) => row.key.trim().length > 0 && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(row.key.trim()),
        );
        if (invalidEnvironmentKey) {
            Modal.alert(t('common.error'), `Invalid environment variable name: ${invalidEnvironmentKey.key}`);
            return;
        }

        setIsSpawning(true);
        try {
            const pathToUse = trimPathInput(selectedPath) || '~';
            const absolutePath = resolveAbsolutePath(pathToUse, selectedMachine.metadata?.homeDir);

            // Handle worktree selection
            let spawnDirectory = absolutePath;
            if (worktreeKey === '__new__') {
                const worktreeResult = await createWorktree(selectedMachineId, absolutePath);
                if (!worktreeResult.success) {
                    Modal.alert(t('common.error'), worktreeResult.error || 'Failed to create worktree');
                    return;
                }
                spawnDirectory = worktreeResult.worktreePath;
            } else if (worktreeKey !== '__none__') {
                // Existing worktree — use its path directly
                spawnDirectory = worktreeKey;
            }

            // Persist last used settings
            sync.applySettings({
                lastUsedAgent: selectedAgent,
                lastUsedPermissionMode: currentPermission.key,
                lastUsedModelMode: currentModelKey,
            });

            const result = await machineSpawnNewSession({
                machineId: selectedMachineId,
                directory: spawnDirectory,
                approvedNewDirectoryCreation,
                agent: selectedAgent,
                environmentVariables,
            });

            switch (result.type) {
                case 'success':
                    await sync.refreshSessions();

                    // Set permission mode and model on the session before sending
                    storage.getState().updateSessionPermissionMode(result.sessionId, currentPermission.key);
                    storage.getState().updateSessionModelMode(result.sessionId, currentModelKey);
                    if (currentEffort?.key) {
                        storage.getState().updateSessionEffortLevel(result.sessionId, currentEffort.key);
                    }

                    if (selectedAgent === 'codex') storage.getState().updateSessionCodexPreferences(result.sessionId, codexPreferences);

                    // Send initial message if provided
                    if (prompt.trim() || pastedImages.length > 0 || attachments.count > 0) {
                        const draftPrompt = prompt.trim();
                        const images = pastedImages.length > 0 ? [...pastedImages] : undefined;
                        const files = await attachments.uploadAll(result.sessionId);
                        const payload = attachmentMessage(draftPrompt, files);
                        await sync.sendMessage(result.sessionId, payload.text, { source: 'new_session', images, displayText: payload.displayText });
                        attachments.clear();
                    }

                    // Clear input text so draft doesn't repeat the sent message
                    setPrompt('');
                    setPastedImages([]);
                    setEnvironmentRowsState([]);
                    draft.setEnvironmentVariables({});

                    router.back();
                    navigateToSession(result.sessionId);
                    break;
                case 'requestToApproveDirectoryCreation': {
                    const approved = await Modal.confirm(
                        'Create Directory?',
                        `The directory '${result.directory}' does not exist. Would you like to create it?`,
                        { cancelText: t('common.cancel'), confirmText: t('common.create') },
                    );
                    if (approved) {
                        await handleSend(true);
                    }
                    break;
                }
                case 'error':
                    Modal.alert(t('common.error'), result.errorMessage);
                    break;
            }
        } catch (error) {
            const errorMessage = error instanceof Error
                ? error.message
                : 'Failed to start session';
            Modal.alert(t('common.error'), errorMessage);
        } finally {
            setIsSpawning(false);
        }
    }, [selectedMachineId, selectedMachine, selectedPath, selectedAgent, prompt, router, navigateToSession, currentPermission.key, currentModelKey, currentEffort?.key, worktreeKey, pastedImages, environmentRows, environmentVariables, voiceBusy, isSpawning, codexPreferences, attachments]);

    const canSend = selectedMachineId && selectedMachine && isMachineOnline(selectedMachine) && !isSpawning && !voiceBusy;

    // Handle Enter/Cmd+Enter to send on web
    const handleKeyPress = React.useCallback((event: KeyPressEvent): boolean => {
        const touchKeyboard = Platform.OS === 'web' && typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;
        if (Platform.OS === 'web' && !touchKeyboard && event.key === 'Enter' && !event.shiftKey && agentInputEnterToSend) {
            if (canSend) {
                handleSend();
                return true;
            }
        }
        return false;
    }, [agentInputEnterToSend, canSend, handleSend]);

    // Desktop can focus immediately. On phones this would cover configuration
    // with the software keyboard before the user has chosen a project.
    const composerInputRef = React.useRef<import('@/components/MultiTextInput').MultiTextInputHandle>(null);
    const configurationScrollRef = React.useRef<ScrollView>(null);
    React.useEffect(() => {
        if (isMobileWeb) return;
        const timeout = setTimeout(() => {
            composerInputRef.current?.focus();
        }, 100);
        return () => clearTimeout(timeout);
    }, [isMobileWeb]);

    return (
        <RootKeyboardView
            {...(Platform.OS === 'web' ? {} : {
                behavior: Platform.OS === 'ios' ? 'padding' as const : 'height' as const,
                keyboardVerticalOffset: Platform.OS === 'ios' ? Constants.statusBarHeight + headerHeight : 0,
            })}
            style={styles.container}
        >
            <View style={styles.inner}>
                <ScrollView
                    ref={configurationScrollRef}
                    style={{ flexShrink: 1 }}
                    contentContainerStyle={{ maxWidth: layout.maxWidth, width: '100%', alignSelf: 'center', paddingHorizontal: isMobileWeb ? 8 : 12, gap: 8, paddingTop: isMobileWeb ? 8 : 12 }}
                    keyboardShouldPersistTaps="handled"
                    alwaysBounceVertical={false}
                >

                    {attachments.input}

                    {/* Config box */}
                    <View style={styles.configBox}>
                        {isConfigExpanded ? (
                            <>
                                {/* Machine row */}
                                <View style={styles.configRowWithToggle}>
                                    <Pressable
                                        style={(p) => [styles.configRow, { flex: 1 }, p.pressed && styles.configRowPressed]}
                                        onPress={() => togglePicker('machine')}
                                        accessibilityRole="button"
                                        accessibilityLabel={`Select machine, current ${machineName}`}
                                    >
                                        <Ionicons name="desktop-outline" size={15} color={theme.colors.textSecondary} />
                                        <Text style={styles.configLabel} numberOfLines={1}>
                                            {machineName}
                                        </Text>
                                    </Pressable>
                                    <Pressable
                                        onPress={toggleConfig}
                                        accessibilityRole="button"
                                        accessibilityLabel="Collapse session configuration"
                                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                                        style={(p) => [styles.collapseToggle, p.pressed && styles.configRowPressed]}
                                    >
                                        <Ionicons name="chevron-up" size={16} color={theme.colors.textSecondary} />
                                    </Pressable>
                                </View>

                                {/* Offline help section — right under machine */}
                                {isOffline && (
                                    <View style={styles.offlineHelp}>
                                        <Ionicons name="cloud-offline-outline" size={14} color={theme.colors.status.disconnected} />
                                        <View style={{ flex: 1 }}>
                                            <Text style={[styles.offlineHelpTitle, { color: theme.colors.status.disconnected }]}>
                                                {t('newSession.machineOffline')}
                                            </Text>
                                            <Text style={[styles.offlineHelpText, { color: theme.colors.textSecondary }]}>
                                                {t('machine.offlineHelp')}
                                                {'\n'}{t('newSession.switchMachinesHint')}
                                            </Text>
                                        </View>
                                    </View>
                                )}

                                {/* Config rows below machine — grayed out when offline */}
                                <View style={{ opacity: isOffline ? 0.4 : 1 }} pointerEvents={isOffline ? 'none' : 'auto'}>
                                    {/* Path row */}
                                    <Pressable
                                        style={(p) => [styles.configRow, p.pressed && styles.configRowPressed]}
                                        onPress={() => togglePicker('path')}
                                        accessibilityRole="button"
                                        accessibilityLabel="选择工作目录"
                                    >
                                        <Ionicons name="folder-outline" size={15} color={theme.colors.textSecondary} />
                                        <Text style={styles.configLabel} numberOfLines={1}>
                                            {pathName}
                                        </Text>
                                    </Pressable>

                                    {/* Agent + model + effort row */}
                                    <View style={[styles.configRow, isMobileWeb && { flexWrap: 'wrap', rowGap: 4, paddingVertical: 5 }]}>
                                        <Pressable
                                            onPress={cycleAgent}
                                            accessibilityRole="button"
                                            accessibilityLabel={`Change CLI, current ${agent.label}`}
                                            style={(p) => [{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: isMobileWeb ? 44 : undefined, minWidth: isMobileWeb ? 44 : undefined, paddingHorizontal: isMobileWeb ? 6 : 0 }, p.pressed && styles.configRowPressed]}
                                        >
                                            <RNImage
                                                source={agentIcons[agent.key]}
                                                style={[styles.agentIcon, { tintColor: theme.colors.textSecondary }]}
                                                resizeMode="contain"
                                            />
                                            <Text style={styles.configLabel} numberOfLines={1}>
                                                {agent.label}
                                            </Text>
                                        </Pressable>

                                        {showModel && (
                                            <>
                                                {isMobileWeb ? null : <Text style={[styles.configLabel, { color: theme.colors.textSecondary }]}>·</Text>}
                                                <Pressable accessibilityRole="button" accessibilityLabel={`Change model, current ${currentModel.name}`} onPress={cycleModel} style={(p) => [{ minHeight: isMobileWeb ? 44 : undefined, minWidth: isMobileWeb ? 44 : undefined, justifyContent: 'center', paddingHorizontal: isMobileWeb ? 6 : 0 }, p.pressed && styles.configRowPressed]}>
                                                    <Text style={[styles.configLabel, { color: theme.colors.textSecondary }]} numberOfLines={1}>
                                                        {currentModel.name}
                                                    </Text>
                                                </Pressable>
                                            </>
                                        )}

                                        {showEffort && (
                                            <>
                                                {isMobileWeb ? null : <Text style={[styles.configLabel, { color: theme.colors.textSecondary }]}>·</Text>}
                                                <Pressable accessibilityRole="button" accessibilityLabel={`Change reasoning effort, current ${currentEffort?.name}`} onPress={cycleEffort} style={(p) => [{ minHeight: isMobileWeb ? 44 : undefined, minWidth: isMobileWeb ? 44 : undefined, justifyContent: 'center', paddingHorizontal: isMobileWeb ? 6 : 0 }, p.pressed && styles.configRowPressed]}>
                                                    <Text style={[styles.configLabel, { color: theme.colors.textSecondary }]} numberOfLines={1}>
                                                        {currentEffort?.name}
                                                    </Text>
                                                </Pressable>
                                            </>
                                        )}
                                    </View>

                                    {/* Permission row */}
                                    {showPermission && (
                                        <Pressable
                                            style={(p) => [styles.configRow, p.pressed && styles.configRowPressed]}
                                            onPress={cyclePermission}
                                            accessibilityRole="button"
                                            accessibilityLabel={`Change permission mode, current ${currentPermission?.name}`}
                                        >
                                            <Ionicons
                                                name={permissionStyle?.icon ?? 'shield-outline'}
                                                size={15}
                                                color={theme.colors.textSecondary}
                                            />
                                            <Text style={styles.configLabel} numberOfLines={1}>
                                                {currentPermission?.name}
                                            </Text>
                                        </Pressable>
                                    )}

                                    {/* Worktree row */}
                                    {supportsWorktree && (
                                        <Pressable
                                            style={(p) => [styles.configRow, p.pressed && styles.configRowPressed]}
                                            onPress={() => togglePicker('worktree')}
                                            accessibilityRole="button"
                                            accessibilityLabel={`Select worktree mode, current ${worktreeLabel}`}
                                        >
                                            <Ionicons name="git-branch-outline" size={15} color={theme.colors.textSecondary} />
                                            <Text style={styles.configLabel} numberOfLines={1}>
                                                {worktreeLabel}
                                            </Text>
                                        </Pressable>
                                    )}

                                    <EnvironmentVariablesEditor
                                        rows={environmentRows}
                                        onChange={setEnvironmentRows}
                                    />
                                </View>

                            </>
                        ) : (
                            /* Collapsed: path row + icons row + optional offline warning */
                            <>
                                {/* Path row with expand chevron */}
                                <View style={styles.configRowWithToggle}>
                                    <Pressable
                                        style={(p) => [styles.collapsedRow, { flex: 1 }, p.pressed && styles.configRowPressed]}
                                        onPress={() => togglePicker('path')}
                                        accessibilityRole="button"
                                        accessibilityLabel="选择工作目录"
                                    >
                                        <Ionicons name="folder-outline" size={15} color={theme.colors.textSecondary} />
                                        <Text style={[styles.configLabel, { flex: 1 }]} numberOfLines={1}>
                                            {pathName}
                                        </Text>
                                    </Pressable>
                                    <Pressable
                                        onPress={toggleConfig}
                                        accessibilityRole="button"
                                        accessibilityLabel="Expand session configuration"
                                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                                        style={(p) => [styles.collapseToggle, p.pressed && styles.configRowPressed]}
                                    >
                                        <Ionicons name="chevron-down" size={16} color={theme.colors.textSecondary} />
                                    </Pressable>
                                </View>

                                {/* Tappable icons row: machine, agent, permission, worktree */}
                                <View style={styles.collapsedIconsRow}>
                                    {/* Machine */}
                                    <Pressable
                                        onPress={() => togglePicker('machine')}
                                        hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
                                        style={(p) => [styles.collapsedIconButton, p.pressed && styles.configRowPressed]}
                                    >
                                        <Ionicons name="desktop-outline" size={14} color={isOffline ? theme.colors.status.disconnected : theme.colors.textSecondary} />
                                    </Pressable>

                                    {/* Agent */}
                                    <Pressable
                                        onPress={() => { cycleAgent(); showFlash(availableAgents[(availableAgents.findIndex(a => a.key === selectedAgent) + 1) % availableAgents.length].label); }}
                                        hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
                                        style={(p) => [styles.collapsedIconButton, p.pressed && styles.configRowPressed]}
                                    >
                                        <RNImage
                                            source={agentIcons[agent.key]}
                                            style={[styles.collapsedAgentIcon, { tintColor: theme.colors.textSecondary }]}
                                            resizeMode="contain"
                                        />
                                    </Pressable>

                                    {/* Permission */}
                                    {showPermission && (
                                        <Pressable
                                            onPress={() => { cyclePermission(); showFlash(permissionModes[(permissionIndex + 1) % permissionModes.length]?.name ?? 'default'); }}
                                            hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
                                            style={(p) => [styles.collapsedIconButton, p.pressed && styles.configRowPressed]}
                                        >
                                            <Ionicons
                                                name={permissionStyle?.icon ?? 'shield-outline'}
                                                size={14}
                                                color={permissionStyle?.color ?? theme.colors.textSecondary}
                                            />
                                        </Pressable>
                                    )}

                                    {/* Worktree */}
                                    {supportsWorktree && (
                                        <Pressable
                                            onPress={() => togglePicker('worktree')}
                                            hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
                                            style={(p) => [styles.collapsedIconButton, p.pressed && styles.configRowPressed]}
                                        >
                                            <Ionicons name="git-branch-outline" size={14} color={theme.colors.textSecondary} />
                                        </Pressable>
                                    )}
                                </View>

                                {/* Offline warning in collapsed state */}
                                {isOffline && (
                                    <View style={styles.offlineHelp}>
                                        <Ionicons name="cloud-offline-outline" size={14} color={theme.colors.status.disconnected} />
                                        <View style={{ flex: 1 }}>
                                            <Text style={[styles.offlineHelpTitle, { color: theme.colors.status.disconnected }]}>
                                                {t('newSession.machineOffline')}
                                            </Text>
                                            <Text style={[styles.offlineHelpText, { color: theme.colors.textSecondary }]}>
                                                {t('machine.offlineHelp')}
                                                {'\n'}{t('newSession.switchMachinesHint')}
                                            </Text>
                                        </View>
                                    </View>
                                )}
                            </>
                        )}
                    </View>

                    {/* Flash label — centered below config box, hidden when picker is open */}
                    {flashText !== '' && !activePicker && (
                        <Animated.View style={[styles.flashLabel, { opacity: flashOpacity }]} pointerEvents="none">
                            <Text style={[styles.flashLabelText, { color: theme.colors.textSecondary }]}>{flashText}</Text>
                        </Animated.View>
                    )}

                    {/* Web: inline popover */}
                    {Platform.OS === 'web' && !isMobileWeb && activePicker && (
                        <View style={[styles.popover, { backgroundColor: theme.colors.header.background }]}
                            onLayout={() => {
                                if (activePicker === 'path') configurationScrollRef.current?.scrollToEnd({ animated: false });
                            }}>
                            {activePicker === 'path' ? (
                                <WorkspaceDirectoryPicker
                                    key={selectedMachineId ?? 'none'}
                                    machineId={selectedMachineId ?? ''}
                                    recent={pathItems}
                                    value={selectedPath}
                                    onSelect={(path) => { setSelectedPath(path); setActivePicker(null); }}
                                    onClose={() => setActivePicker(null)}
                                />
                            ) : pickerData ? (
                                <PickerContent {...pickerData} onSelect={handlePickerSelect} />
                            ) : null}
                        </View>
                    )}
                </ScrollView>

                {/* Web: click-away backdrop */}
                {Platform.OS === 'web' && !isMobileWeb && activePicker && (
                    <Pressable
                        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: -1 }}
                        onPress={() => setActivePicker(null)}
                    />
                )}

                {/* Spacer */}
                <View style={{ flex: 1 }} />

                <View style={{ maxWidth: layout.maxWidth, width: '100%', alignSelf: 'center', paddingHorizontal: isMobileWeb ? 8 : 12, gap: 8 }}>
                    {showProminentMobileWebImageButton && (
                        <Pressable
                            onPress={handlePickImages}
                            accessibilityRole="button"
                            accessibilityLabel={hasImages ? "Attach more images" : "Attach image"}
                            style={(p) => [
                                styles.mobileImageButton,
                                {
                                    borderColor: theme.colors.divider,
                                    backgroundColor: theme.colors.input.background,
                                    opacity: p.pressed ? 0.75 : 1,
                                },
                            ]}
                        >
                            <Ionicons
                                name="image-outline"
                                size={18}
                                color={theme.colors.button.secondary.tint}
                            />
                            <Text style={[styles.mobileImageButtonText, { color: theme.colors.text }]}>
                                {hasImages ? t('agentInput.addMoreImages') : t('agentInput.attachImage')}
                            </Text>
                        </Pressable>
                    )}

                    {hasImages && (
                        <View style={styles.imagePreviewRow}>
                            {pastedImages.map((img, index) => (
                                <View key={`${img.mediaType}-${index}`} style={styles.imagePreviewItem}>
                                    <RNImage
                                        source={{ uri: `data:${img.mediaType};base64,${img.previewData ?? img.data}` }}
                                        style={styles.imagePreview}
                                        resizeMode="cover"
                                    />
                                    <Pressable
                                        onPress={() => setPastedImages((prev) => prev.filter((_, i) => i !== index))}
                                        accessibilityRole="button"
                                        accessibilityLabel={`Remove image ${index + 1}`}
                                        hitSlop={10}
                                        style={[styles.imageRemoveButton, { backgroundColor: theme.colors.surfaceHigh }]}
                                    >
                                        <Ionicons name="close" size={14} color={theme.colors.text} />
                                    </Pressable>
                                </View>
                            ))}
                        </View>
                    )}

                    {/* Input box */}
                    <View style={styles.inputBox}>
                        {attachments.preview}
                        <VoiceInputStatus feedback={voiceFeedback} />
                        <View style={styles.inputField}>
                            <View style={{ flex: 1 }}>
                                <MultiTextInput
                                    ref={composerInputRef}
                                    value={prompt}
                                    onChangeText={setPrompt}
                                    placeholder="What would you like to work on?"
                                    accessibilityLabel="Session prompt"
                                    minHeight={isMobileWeb ? 44 : undefined}
                                    paddingTop={COMPOSER_INPUT_VERTICAL_PADDING}
                                    paddingBottom={COMPOSER_INPUT_VERTICAL_PADDING}
                                    maxHeight={240}
                                    onKeyPress={handleKeyPress}
                                    {...(Platform.OS === 'web' ? {
                                        onPasteImages: (images: PastedImage[]) => {
                                            setPastedImages((prev) => [...prev, ...images]);
                                        },
                                    } : {})}
                                />
                            </View>
                        </View>
                        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 8, paddingBottom: 6 }}>
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                                <Pressable accessibilityRole="button" accessibilityLabel="添加附件" onPress={attachments.pick} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
                                    <Ionicons name="attach-outline" size={20} color={theme.colors.button.secondary.tint} />
                                </Pressable>
                                {!showProminentMobileWebImageButton && <Pressable accessibilityRole="button" accessibilityLabel="Attach image" onPress={handlePickImages} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
                                    <Ionicons name="image-outline" size={18} color={theme.colors.button.secondary.tint} />
                                </Pressable>}
                                <VoiceInput value={prompt} onChangeText={setPrompt} onBusyChange={setVoiceBusy} onFeedbackChange={setVoiceFeedback} scope={`new:${selectedMachineId}:${selectedPath}`} />
                                {Platform.OS === 'web' && selectedAgent === 'codex' && <Pressable accessibilityRole="button" accessibilityLabel="Open session settings" accessibilityState={{ expanded: showReplySettings }} onPress={() => setShowReplySettings(true)} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
                                    <Octicons name="gear" size={16} color={theme.colors.button.secondary.tint} />
                                </Pressable>}
                            </View>
                            <View style={[
                                styles.sendButton,
                                isMobileWeb && { width: 44, height: 44, borderRadius: 22, marginBottom: 0 },
                                canSend ? styles.sendButtonActive : styles.sendButtonInactive,
                            ]}>
                                <Pressable
                                    style={(p) => ({
                                        width: '100%',
                                        height: '100%',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        opacity: p.pressed ? 0.7 : 1,
                                    })}
                                    disabled={!canSend}
                                    onPress={() => handleSend()}
                                    accessibilityRole="button"
                                    accessibilityLabel={isSpawning ? "Starting session" : "Start session"}
                                >
                                    {isSpawning ? (
                                        <ActivityIndicator
                                            size="small"
                                            color={theme.colors.button.primary.tint}
                                        />
                                    ) : (
                                        <Octicons
                                            name="arrow-up"
                                            size={16}
                                            color={theme.colors.button.primary.tint}
                                            style={{ marginTop: Platform.OS === 'web' ? 2 : 0 }}
                                        />
                                    )}
                                </Pressable>
                            </View>
                        </View>
                    </View>
                </View>

                <View style={{ height: Math.max(16, safeArea.bottom) }} />
            </View>

            {/* Native: picker bottom sheet */}
            <BottomSheet visible={showReplySettings && selectedAgent === 'codex'} onClose={() => setShowReplySettings(false)}>
                <Pressable accessibilityRole="button" accessibilityLabel="关闭回复设置" onPress={() => setShowReplySettings(false)} style={{ alignSelf: 'flex-end', width: 44, height: 44, alignItems: 'center', justifyContent: 'center', marginRight: 8 }}>
                    <Ionicons name="close" size={20} color={theme.colors.textSecondary} />
                </Pressable>
                <ScrollView style={{ flexShrink: 1 }} keyboardShouldPersistTaps="handled">
                    <CodexControls preferences={codexPreferences} onChange={setCodexPreferences} effort={currentEffort} efforts={effortLevels}
                        onEffortChange={level => { setEffortIndex(effortLevels.findIndex(option => option.key === level.key)); draft.setEffortLevel(level.key); }} serviceTiers={currentModel.supportedServiceTiers} />
                </ScrollView>
            </BottomSheet>
            {(Platform.OS !== 'web' || isMobileWeb) && (
                <BottomSheet
                    visible={!!activePicker}
                    onClose={() => setActivePicker(null)}
                >
                    {activePicker === 'path' ? (
                        <WorkspaceDirectoryPicker
                                    key={selectedMachineId ?? 'none'}
                                    machineId={selectedMachineId ?? ''}
                                    recent={pathItems}
                                    value={selectedPath}
                                    onSelect={(path) => { setSelectedPath(path); setActivePicker(null); }}
                                    onClose={() => setActivePicker(null)}
                                />
                    ) : pickerData ? (
                        <PickerContent {...pickerData} onSelect={handlePickerSelect} />
                    ) : null}
                </BottomSheet>
            )}
        </RootKeyboardView>
    );
}

const WORKTREE_FIXED_ITEMS: PickerItem[] = [
    { key: '__none__', label: 'no worktree' },
    { key: '__new__', label: 'new worktree' },
];

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.header.background,
    },
    inner: {
        flex: 1,
    },
    configBox: {
        backgroundColor: theme.colors.input.background,
        borderRadius: Platform.select({ default: 16, android: 20 }),
        paddingVertical: 4,
        paddingHorizontal: 4,
        overflow: 'hidden',
    },
    popover: {
        borderRadius: 12,
        paddingVertical: 4,
        marginTop: 4,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        ...Platform.select({
            web: {
                boxShadow: '0 4px 20px rgba(0, 0, 0, 0.12)',
            },
            default: {
                shadowColor: '#000',
                shadowOffset: { width: 0, height: 4 },
                shadowOpacity: 0.12,
                shadowRadius: 10,
                elevation: 8,
            },
        }),
    },
    configRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderRadius: 12,
        minHeight: 44,
    },
    configRowWithToggle: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    collapseToggle: {
        minWidth: 44,
        minHeight: 44,
        paddingHorizontal: 12,
        paddingVertical: 10,
        justifyContent: 'center',
        alignItems: 'center',
    },
    collapsedRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderRadius: 12,
        minHeight: 44,
    },
    collapsedIconsRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 2,
        paddingHorizontal: 4,
        paddingBottom: 8,
    },
    collapsedIconButton: {
        width: 42,
        height: 40,
        borderRadius: 8,
        justifyContent: 'center',
        alignItems: 'center',
    },
    flashLabel: {
        alignSelf: 'center',
        paddingVertical: 4,
    },
    flashLabelText: {
        fontSize: theme.typography.caption.fontSize,
        ...Typography.default(),
    },
    configRowPressed: {
        opacity: 0.6,
    },
    agentIcon: {
        width: 15,
        height: 15,
    },
    collapsedAgentIcon: {
        width: 14,
        height: 14,
    },
    configLabel: {
        fontSize: theme.typography.label.fontSize,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
        ...Platform.select({ web: { userSelect: 'none' } as any, default: {} }),
    },
    envEditor: {
        gap: 8,
        paddingHorizontal: 12,
        paddingVertical: 10,
    },
    envHeader: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 8,
    },
    envTitle: {
        fontSize: theme.typography.small.fontSize,
        ...Typography.default('semiBold'),
    },
    envHint: {
        fontSize: theme.typography.caption.fontSize,
        lineHeight: theme.typography.caption.lineHeight,
        marginTop: 2,
        ...Typography.default(),
    },
    envRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    envInput: {
        flex: 1,
        minWidth: 0,
        borderWidth: 1,
        borderRadius: 8,
        paddingHorizontal: 9,
        paddingVertical: 7,
        fontSize: theme.typography.code.fontSize,
        fontFamily: Platform.OS === 'web' ? 'monospace' : undefined,
    },
    envKeyInput: {
        flex: 0.8,
    },
    envIconButton: {
        width: 30,
        height: 30,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 8,
    },
    envAddButton: {
        alignSelf: 'flex-start',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        paddingVertical: 4,
    },
    envAddLabel: {
        fontSize: theme.typography.caption.fontSize,
        ...Typography.default('semiBold'),
    },
    inputBox: {
        backgroundColor: theme.colors.input.background,
        borderRadius: Platform.select({ default: 16, android: 20 }),
        overflow: 'hidden',
        paddingVertical: 2,
        paddingHorizontal: 8,
    },
    inputField: {
        flexDirection: 'row',
        alignItems: 'flex-end',
        paddingLeft: 8,
        paddingRight: 4,
        paddingVertical: 4,
        minHeight: 44,
        gap: 8,
    },
    mobileImageButton: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        borderRadius: 12,
        borderWidth: 1,
        paddingHorizontal: 12,
        paddingVertical: 10,
        minHeight: 44,
    },
    mobileImageButtonText: {
        fontSize: theme.typography.label.fontSize,
        ...Typography.default('semiBold'),
    },
    imagePreviewRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
        paddingHorizontal: 4,
    },
    imagePreviewItem: {
        position: 'relative',
    },
    imagePreview: {
        width: 64,
        height: 64,
        borderRadius: 8,
    },
    imageRemoveButton: {
        position: 'absolute',
        top: -6,
        right: -6,
        width: 20,
        height: 20,
        borderRadius: 10,
        alignItems: 'center',
        justifyContent: 'center',
    },
    inlineImageButton: {
        width: 32,
        height: 32,
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: Math.max(0, Math.round((theme.typography.body.lineHeight + COMPOSER_INPUT_VERTICAL_PADDING * 2 - COMPOSER_SEND_BUTTON_SIZE) / 2)),
    },
    sendButton: {
        width: COMPOSER_SEND_BUTTON_SIZE,
        height: COMPOSER_SEND_BUTTON_SIZE,
        borderRadius: COMPOSER_SEND_BUTTON_SIZE / 2,
        justifyContent: 'center',
        alignItems: 'center',
        flexShrink: 0,
        marginBottom: Math.max(0, Math.round((theme.typography.body.lineHeight + COMPOSER_INPUT_VERTICAL_PADDING * 2 - COMPOSER_SEND_BUTTON_SIZE) / 2)),
    },
    sendButtonActive: {
        backgroundColor: theme.colors.button.primary.background,
    },
    sendButtonInactive: {
        backgroundColor: theme.colors.button.primary.disabled,
    },
    offlineHelp: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 8,
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderRadius: 12,
    },
    offlineHelpTitle: {
        fontSize: theme.typography.small.fontSize,
        ...Typography.default('semiBold'),
        marginBottom: 4,
    },
    offlineHelpText: {
        fontSize: theme.typography.caption.fontSize,
        lineHeight: theme.typography.caption.lineHeight,
        ...Typography.default(),
    },
}));

// Bottom sheet styles
const sheetStyles = StyleSheet.create((theme) => ({
    iosContainer: {
        flex: 1,
    } as const,
    handleRow: {
        alignItems: 'center' as const,
        paddingTop: 10,
        paddingBottom: 6,
    },
    handle: {
        width: 36,
        height: 4,
        borderRadius: 2,
        opacity: 0.3,
    },
    overlay: {
        flex: 1,
        justifyContent: 'flex-end' as const,
    },
    backdrop: {
        position: 'absolute' as const,
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.4)',
    },
    sheet: {
        width: '100%' as const,
        maxWidth: layout.maxWidth,
        alignSelf: 'center' as const,
        borderTopLeftRadius: 16,
        borderTopRightRadius: 16,
        maxHeight: '70%' as const,
    },
}));

// Picker styles
const pickerStyles = StyleSheet.create((theme) => ({
    container: {
        paddingHorizontal: 16,
        paddingBottom: 8,
    } as const,
    title: {
        fontSize: theme.typography.subheading.fontSize,
        paddingVertical: 12,
        paddingHorizontal: 4,
        ...Typography.default('semiBold'),
        ...Platform.select({ web: { userSelect: 'none' } as any, default: {} }),
    } as const,
    searchRow: {
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
        gap: 10,
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderRadius: 12,
        marginBottom: 8,
    },
    searchInput: {
        flex: 1,
        fontSize: theme.typography.body.fontSize,
        padding: 0,
        ...Typography.default(),
        ...Platform.select({ web: { outlineStyle: 'none' } as any, default: {} }),
    } as const,
    option: {
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
        gap: 12,
        paddingHorizontal: 12,
        paddingVertical: 12,
        borderRadius: 12,
    },
    optionPressed: {
        opacity: 0.6,
    } as const,
    optionText: {
        fontSize: theme.typography.body.fontSize,
        ...Typography.default(),
        ...Platform.select({ web: { userSelect: 'none' } as any, default: {} }),
    } as const,
    divider: {
        height: 1,
        marginHorizontal: 12,
        marginVertical: 4,
    } as const,
    optionList: {
        flexGrow: 0,
        flexShrink: 1,
    } as const,
    emptyText: {
        fontSize: theme.typography.label.fontSize,
        textAlign: 'center' as const,
        paddingVertical: 20,
        ...Typography.default(),
        ...Platform.select({ web: { userSelect: 'none' } as any, default: {} }),
    } as const,
}));

export default React.memo(function FocusedNewSessionScreen() {
    const focused = useIsFocused();
    return focused ? <NewSessionScreen /> : null;
});
