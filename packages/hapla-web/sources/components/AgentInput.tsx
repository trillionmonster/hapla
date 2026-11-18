import Ionicons from '@expo/vector-icons/Ionicons';
import Octicons from '@expo/vector-icons/Octicons';
import * as React from 'react';
import { View, Platform, useWindowDimensions, ViewStyle, Text, ActivityIndicator, TouchableWithoutFeedback, Image as RNImage, Pressable } from 'react-native';
import { Image } from 'expo-image';
import { layout } from './layout';
import { MultiTextInput, KeyPressEvent } from './MultiTextInput';
import { Typography } from '@/constants/Typography';
import { PermissionMode, ModelMode } from './PermissionModeSelector';
import { EffortLevel } from './modelModeOptions';
import { hapticsLight, hapticsError } from './haptics';
import { Shaker, ShakeInstance } from './Shaker';
import { StatusDot } from './StatusDot';
import { useActiveWord } from './autocomplete/useActiveWord';
import { useActiveSuggestions } from './autocomplete/useActiveSuggestions';
import { AgentInputAutocomplete } from './AgentInputAutocomplete';
import { FloatingOverlay } from './FloatingOverlay';
import { TextInputState, MultiTextInputHandle } from './MultiTextInput';
import { applySuggestion } from './autocomplete/applySuggestion';
import { GitStatusBadge, useHasMeaningfulGitStatus } from './GitStatusBadge';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSetting } from '@/sync/storage';
import { hackMode, hackModes } from '@/sync/modeHacks';
import { Theme } from '@/theme';
import { t } from '@/text';
import { Metadata } from '@/sync/storageTypes';
import { Modal } from '@/modal';
import {
    getWebImageFailureMessage,
    prepareWebImagesForUpload,
    readWebImageFiles,
    WEB_IMAGE_INPUT_ACCEPT,
} from '@/utils/webImageUpload';
import { canNavigateInputHistory } from './inputHistory';
import { VoiceInput, VoiceInputStatus, type VoiceInputFeedback } from './VoiceInput';
import { CodexControls } from './CodexControls';
import type { CodexPreferences } from '@/sync/codexPreferences';

export interface PastedImage {
    data: string; // base64
    mediaType: string; // e.g. 'image/png'
    previewData?: string;
}

interface AgentInputProps {
    codexPreferences?: CodexPreferences;
    onCodexPreferencesChange?: (preferences: CodexPreferences) => void;
    value: string;
    placeholder: string;
    onChangeText: (text: string) => void;
    sessionId?: string;
    onSend: () => void;
    sendIcon?: React.ReactNode;
    permissionMode?: PermissionMode | null;
    availableModes?: PermissionMode[];
    onPermissionModeChange?: (mode: PermissionMode) => void;
    modelMode?: ModelMode | null;
    availableModels?: ModelMode[];
    onModelModeChange?: (mode: ModelMode) => void;
    effortLevel?: EffortLevel | null;
    availableEffortLevels?: EffortLevel[];
    onEffortLevelChange?: (level: EffortLevel) => void;
    metadata?: Metadata | null;
    onAbort?: () => void | Promise<void>;
    showAbortButton?: boolean;
    connectionStatus?: {
        text: string;
        color: string;
        dotColor: string;
        isPulsing?: boolean;
        cliStatus?: {
            claude: boolean | null;
            codex: boolean | null;
        };
    };
    autocompletePrefixes: string[];
    autocompleteSuggestions: (query: string) => Promise<{ key: string, text: string, component: React.ElementType }[]>;
    usageData?: {
        inputTokens: number;
        outputTokens: number;
        cacheCreation: number;
        cacheRead: number;
        contextSize: number;
    };
    alwaysShowContextSize?: boolean;
    onFileViewerPress?: () => void;
    agentType?: 'claude' | 'codex';
    onAgentClick?: () => void;
    machineName?: string | null;
    onMachineClick?: () => void;
    currentPath?: string | null;
    onPathClick?: () => void;
    isSendDisabled?: boolean;
    isSending?: boolean;
    minHeight?: number;
    images?: PastedImage[];
    onPasteImages?: (images: PastedImage[]) => void;
    onRemoveImage?: (index: number) => void;
    inputHistory?: readonly string[];
    historyKey?: string;
    onPickFiles?: () => void;
    attachmentCount?: number;
    attachmentPreview?: React.ReactNode;
}

const MAX_CONTEXT_SIZE = 190000;

const stylesheet = StyleSheet.create((theme, runtime) => ({
    container: {
        alignItems: 'center',
        paddingBottom: 12,
        paddingTop: 10,
    },
    innerContainer: {
        width: '100%',
        position: 'relative',
    },
    unifiedPanel: {
        backgroundColor: theme.colors.input.background,
        borderRadius: 24,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        overflow: 'hidden',
        paddingVertical: 2,
        paddingBottom: 7,
        paddingHorizontal: 9,
    },
    inputContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        borderWidth: 0,
        paddingLeft: 8,
        paddingRight: 8,
        paddingVertical: 4,
        minHeight: 40,
    },

    // Overlay styles
    autocompleteOverlay: {
        position: 'absolute',
        bottom: '100%',
        left: 0,
        right: 0,
        marginBottom: 8,
        zIndex: 1000,
    },
    settingsOverlay: {
        position: 'absolute',
        bottom: '100%',
        left: 0,
        right: 0,
        marginBottom: 8,
        zIndex: 1000,
    },
    overlayBackdrop: {
        position: 'absolute',
        top: -1000,
        left: -1000,
        right: -1000,
        bottom: -1000,
        zIndex: 999,
    },
    overlaySection: {
        paddingVertical: 8,
    },
    overlaySectionTitle: {
        fontSize: theme.typography.caption.fontSize,
        fontWeight: '600',
        color: theme.colors.textSecondary,
        paddingHorizontal: 16,
        paddingBottom: 4,
        ...Typography.default('semiBold'),
    },
    overlayDivider: {
        height: 1,
        backgroundColor: theme.colors.divider,
        marginHorizontal: 16,
    },

    // Selection styles
    selectionItem: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 8,
        backgroundColor: 'transparent',
    },
    selectionItemPressed: {
        backgroundColor: theme.colors.surfacePressed,
    },
    radioButton: {
        width: 16,
        height: 16,
        borderRadius: 8,
        borderWidth: 2,
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: 12,
    },
    radioButtonActive: {
        borderColor: theme.colors.radio.active,
    },
    radioButtonInactive: {
        borderColor: theme.colors.radio.inactive,
    },
    radioButtonDot: {
        width: 6,
        height: 6,
        borderRadius: 3,
        backgroundColor: theme.colors.radio.dot,
    },
    selectionLabel: {
        fontSize: theme.typography.label.fontSize,
        ...Typography.default(),
    },
    selectionLabelActive: {
        color: theme.colors.radio.active,
    },
    selectionLabelInactive: {
        color: theme.colors.text,
    },

    // Status styles
    statusContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 16,
        paddingBottom: 4,
    },
    statusRow: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    statusText: {
        fontSize: theme.typography.caption.fontSize,
        ...Typography.default(),
    },
    permissionModeContainer: {
        flexDirection: 'column',
        alignItems: 'flex-end',
    },
    permissionModeText: {
        fontSize: theme.typography.caption.fontSize,
        ...Typography.default(),
    },
    contextWarningText: {
        fontSize: theme.typography.caption.fontSize,
        marginLeft: 8,
        ...Typography.default(),
    },

    // Button styles
    actionButtonsContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 0,
    },
    actionButtonsLeft: {
        flexDirection: 'row',
        gap: 8,
        flex: 1,
        overflow: 'hidden',
    },
    actionButton: {
        flexDirection: 'row',
        alignItems: 'center',
        borderRadius: Platform.select({ default: 16, android: 20 }),
        paddingHorizontal: 8,
        paddingVertical: 6,
        justifyContent: 'center',
        minWidth: 44,
        height: 44,
    },
    actionButtonPressed: {
        opacity: 0.7,
    },
    actionButtonIcon: {
        color: theme.colors.button.secondary.tint,
    },
    sendButton: {
        width: 44,
        height: 44,
        borderRadius: 22,
        justifyContent: 'center',
        alignItems: 'center',
        flexShrink: 0,
        marginLeft: 8,
    },
    sendButtonActive: {
        backgroundColor: theme.colors.button.primary.background,
    },
    sendButtonInactive: {
        backgroundColor: theme.colors.button.primary.disabled,
    },
    sendButtonInner: {
        width: '100%',
        height: '100%',
        alignItems: 'center',
        justifyContent: 'center',
    },
    sendButtonInnerPressed: {
        opacity: 0.7,
    },
    sendButtonIcon: {
        color: theme.colors.button.primary.tint,
    },
}));

const getContextWarning = (contextSize: number, alwaysShow: boolean = false, theme: Theme) => {
    const percentageUsed = (contextSize / MAX_CONTEXT_SIZE) * 100;
    const percentageRemaining = Math.max(0, Math.min(100, 100 - percentageUsed));

    if (percentageRemaining <= 5) {
        return { text: t('agentInput.context.remaining', { percent: Math.round(percentageRemaining) }), color: theme.colors.warningCritical };
    } else if (percentageRemaining <= 10) {
        return { text: t('agentInput.context.remaining', { percent: Math.round(percentageRemaining) }), color: theme.colors.warning };
    } else if (alwaysShow) {
        // Show context remaining in neutral color when not near limit
        return { text: t('agentInput.context.remaining', { percent: Math.round(percentageRemaining) }), color: theme.colors.warning };
    }
    return null; // No display needed
};

export const AgentInput = React.memo(React.forwardRef<MultiTextInputHandle, AgentInputProps>((props, ref) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const screenWidth = useWindowDimensions().width;
    const hasText = props.value.trim().length > 0;
    const hasImages = (props.images?.length ?? 0) > 0;
    const hasContent = hasText || hasImages || (props.attachmentCount ?? 0) > 0;
    const isMobileWeb = Platform.OS === 'web' && screenWidth <= 700;
    // Force the icon-only image button (kept inline with other action buttons) on every platform.
    // The previous "prominent" mobile-web variant lived in its own row, which users disliked.
    const showProminentMobileWebImageButton = false;

    // Hidden file input for web image picking (created lazily on web only)
    const webFileInputRef = React.useRef<HTMLInputElement | null>(null);
    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
        if (typeof document === 'undefined') return;
        if (webFileInputRef.current) return;
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = WEB_IMAGE_INPUT_ACCEPT;
        input.multiple = true;
        // Mobile browsers can ignore programmatic clicks on fully hidden file inputs.
        // Keep it in the DOM and off-screen so the picker remains user-triggered.
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
            if (input.parentNode) input.parentNode.removeChild(input);
            webFileInputRef.current = null;
        };
    }, []);

    const handleIncomingImages = React.useCallback(async (images: PastedImage[]) => {
        if (!props.onPasteImages || images.length === 0) {
            return;
        }

        if (Platform.OS !== 'web') {
            props.onPasteImages(images);
            return;
        }

        const { acceptedImages, rejectedImages } = await prepareWebImagesForUpload(images);
        if (acceptedImages.length > 0) {
            props.onPasteImages(acceptedImages);
        }
        if (rejectedImages.length > 0) {
            console.error('Rejected web images before send:', rejectedImages.map((image) => image.mediaType));
            Modal.alert(t('common.error'), getWebImageFailureMessage(rejectedImages));
        }
    }, [props.onPasteImages]);

    // Image picker handler — works on native (expo-image-picker) and web (file input)
    const handlePickImages = React.useCallback(async () => {
        if (!props.onPasteImages) return;

        if (Platform.OS === 'web') {
            const input = webFileInputRef.current;
            if (!input) return;
            // Re-bind onchange every time so we capture the latest callback
            input.onchange = async () => {
                const files = input.files ? Array.from(input.files) : [];
                // Reset value so selecting the same file again still triggers change
                input.value = '';
                if (files.length === 0) return;
                const imageFiles = files.filter(f => f.type.startsWith('image/'));
                if (imageFiles.length === 0) return;
                const results = await readWebImageFiles(imageFiles);
                if (results.length > 0) {
                    void handleIncomingImages(results);
                }
            };
            input.click();
            return;
        }

        const ImagePicker = await import('expo-image-picker');
        const result = await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ['images'],
            allowsMultipleSelection: true,
            base64: true,
            quality: 0.8,
        });
        if (result.canceled || !result.assets) return;
        const images: PastedImage[] = result.assets
            .filter(a => a.base64)
            .map(a => ({
                data: a.base64!,
                mediaType: a.mimeType ?? 'image/jpeg',
            }));
        if (images.length > 0) {
            hapticsLight();
            void handleIncomingImages(images);
        }
    }, [handleIncomingImages, props.onPasteImages]);
    const [voiceBusy, setVoiceBusy] = React.useState(false);
    const [voiceFeedback, setVoiceFeedback] = React.useState<VoiceInputFeedback | null>(null);
    const canPressSendButton = !props.isSending && !voiceBusy
        && !props.isSendDisabled
        && hasContent;

    // Use metadata.flavor for existing sessions, agentType for new sessions.
    const isCodex = props.metadata?.flavor === 'codex' || props.agentType === 'codex';
    const displayPermissionMode = React.useMemo(() => (
        props.permissionMode ? hackMode(props.permissionMode) : null
    ), [props.permissionMode]);
    const permissionModeKey = displayPermissionMode?.key ?? 'default';
    const availableModes = React.useMemo(() => (
        hackModes(props.availableModes ?? [])
    ), [props.availableModes]);
    const availableModels = props.availableModels ?? [];
    const availableEffortLevels = props.availableEffortLevels ?? [];
    const hasCodexControls = Platform.OS === 'web' && isCodex && !!props.codexPreferences && !!props.onCodexPreferencesChange;
    const isSandboxEnabled = React.useMemo(() => {
        const sandbox = props.metadata?.sandbox as unknown;
        if (!sandbox) {
            return false;
        }
        if (typeof sandbox === 'object' && sandbox !== null && 'enabled' in sandbox) {
            return Boolean((sandbox as { enabled?: unknown }).enabled);
        }
        return true;
    }, [props.metadata?.sandbox]);
    const isSandboxedYoloMode = isSandboxEnabled && (
        permissionModeKey === 'bypassPermissions' || permissionModeKey === 'yolo'
    );

    const withSandboxSuffix = React.useCallback((label: string, modeKey?: string) => {
        if (!isSandboxEnabled) {
            return label;
        }
        if (modeKey === 'bypassPermissions' || modeKey === 'yolo') {
            return `${label} (sandboxed)`;
        }
        return label;
    }, [isSandboxEnabled]);

    // Calculate context warning
    const contextWarning = props.usageData?.contextSize
        ? getContextWarning(props.usageData.contextSize, props.alwaysShowContextSize ?? false, theme)
        : null;

    const agentInputEnterToSend = useSetting('agentInputEnterToSend');


    // Abort button state
    const [isAborting, setIsAborting] = React.useState(false);
    const shakerRef = React.useRef<ShakeInstance>(null);
    const inputRef = React.useRef<MultiTextInputHandle>(null);

    // Forward ref to the MultiTextInput
    React.useImperativeHandle(ref, () => inputRef.current!, []);

    // Autocomplete state - track text and selection together
    const [inputState, setInputState] = React.useState<TextInputState>({
        text: props.value,
        selection: { start: 0, end: 0 }
    });
    const historyIndexRef = React.useRef(-1);
    const historyDraftRef = React.useRef('');
    const applyingHistoryRef = React.useRef(false);
    const [showInputHistory, setShowInputHistory] = React.useState(false);

    React.useEffect(() => {
        setInputState((current) => current.text === props.value
            ? current
            : {
                text: props.value,
                selection: { start: props.value.length, end: props.value.length },
            });
    }, [props.value]);

    React.useEffect(() => {
        historyIndexRef.current = -1;
        historyDraftRef.current = '';
        setShowInputHistory(false);
    }, [props.historyKey, props.sessionId]);

    const setInputFromHistory = React.useCallback((text: string) => {
        const selection = { start: text.length, end: text.length };
        applyingHistoryRef.current = true;
        inputRef.current?.setTextAndSelection(text, selection);
        applyingHistoryRef.current = false;
        setInputState({ text, selection });
    }, []);

    const handleComposerTextChange = React.useCallback((text: string) => {
        if (!applyingHistoryRef.current) {
            historyIndexRef.current = -1;
            historyDraftRef.current = '';
        }
        props.onChangeText(text);
    }, [props.onChangeText]);

    const navigateInputHistory = React.useCallback((direction: 'up' | 'down') => {
        const history = props.inputHistory ?? [];
        if (history.length === 0 || !canNavigateInputHistory(direction, inputState.text, inputState.selection)) {
            return false;
        }

        const currentIndex = historyIndexRef.current;
        if (direction === 'up') {
            if (currentIndex === -1) {
                historyDraftRef.current = props.value;
            }
            const nextIndex = Math.min(currentIndex + 1, history.length - 1);
            historyIndexRef.current = nextIndex;
            setInputFromHistory(history[nextIndex]);
            return true;
        }

        if (currentIndex === -1) {
            return false;
        }
        const nextIndex = currentIndex - 1;
        historyIndexRef.current = nextIndex;
        setInputFromHistory(nextIndex >= 0 ? history[nextIndex] : historyDraftRef.current);
        return true;
    }, [inputState, props.inputHistory, props.value, setInputFromHistory]);

    // Handle combined text and selection state changes
    const handleInputStateChange = React.useCallback((newState: TextInputState) => {
        // console.log('📝 Input state changed:', JSON.stringify(newState));
        setInputState(newState);
    }, []);

    // Use the tracked selection from inputState
    const activeWord = useActiveWord(inputState.text, inputState.selection, props.autocompletePrefixes);
    // Using default options: clampSelection=true, autoSelectFirst=true, wrapAround=true
    // To customize: useActiveSuggestions(activeWord, props.autocompleteSuggestions, { clampSelection: false, wrapAround: false })
    const [suggestions, selected, moveUp, moveDown] = useActiveSuggestions(activeWord, props.autocompleteSuggestions, { clampSelection: true, wrapAround: true });

    // Debug logging
    // React.useEffect(() => {
    //     console.log('🔍 Autocomplete Debug:', JSON.stringify({
    //         value: props.value,
    //         inputState,
    //         activeWord,
    //         suggestionsCount: suggestions.length,
    //         selected,
    //         prefixes: props.autocompletePrefixes
    //     }, null, 2));
    // }, [props.value, inputState, activeWord, suggestions.length, selected]);

    // Handle suggestion selection
    const handleSuggestionSelect = React.useCallback((index: number) => {
        if (!suggestions[index] || !inputRef.current) return;

        const suggestion = suggestions[index];

        // Apply the suggestion
        const result = applySuggestion(
            inputState.text,
            inputState.selection,
            suggestion.text,
            props.autocompletePrefixes,
            true // add space after
        );

        // Use imperative API to set text and selection
        inputRef.current.setTextAndSelection(result.text, {
            start: result.cursorPosition,
            end: result.cursorPosition
        });

        // console.log('Selected suggestion:', suggestion.text);

        // Small haptic feedback
        hapticsLight();
    }, [suggestions, inputState, props.autocompletePrefixes]);

    // Settings modal state
    const [showSettings, setShowSettings] = React.useState(false);

    // Handle settings button press
    const handleSettingsPress = React.useCallback(() => {
        hapticsLight();
        setShowInputHistory(false);
        setShowSettings(prev => !prev);
    }, []);

    // Handle settings selection
    const handleSettingsSelect = React.useCallback((mode: PermissionMode) => {
        hapticsLight();
        props.onPermissionModeChange?.(mode);
        setShowSettings(false);
    }, [props.onPermissionModeChange]);

    // Handle abort button press
    const handleAbortPress = React.useCallback(async () => {
        if (!props.onAbort) return;

        hapticsError();
        setIsAborting(true);
        const startTime = Date.now();

        try {
            await props.onAbort?.();

            // Ensure minimum 300ms loading time
            const elapsed = Date.now() - startTime;
            if (elapsed < 300) {
                await new Promise(resolve => setTimeout(resolve, 300 - elapsed));
            }
        } catch (error) {
            // Shake on error
            shakerRef.current?.shake();
            console.error('Abort RPC call failed:', error);
            Modal.alert('中断失败，可重试', error instanceof Error ? error.message : '未能确认当前任务已经停止');
        } finally {
            setIsAborting(false);
        }
    }, [props.onAbort]);

    const handleSendPress = React.useCallback(() => {
        if (props.isSendDisabled || props.isSending || voiceBusy) return;

        hapticsLight();
        if (hasContent) props.onSend();
    }, [hasContent, props, voiceBusy]);

    // Handle keyboard navigation
    const handleKeyPress = React.useCallback((event: KeyPressEvent): boolean => {
        // Handle autocomplete navigation first
        if (suggestions.length > 0) {
            if (event.key === 'ArrowUp') {
                moveUp();
                return true;
            } else if (event.key === 'ArrowDown') {
                moveDown();
                return true;
            } else if ((event.key === 'Enter' || (event.key === 'Tab' && !event.shiftKey))) {
                // Both Enter and Tab select the current suggestion
                // If none selected (selected === -1), select the first one
                const indexToSelect = selected >= 0 ? selected : 0;
                handleSuggestionSelect(indexToSelect);
                return true;
            } else if (event.key === 'Escape') {
                // Clear suggestions by collapsing selection (triggers activeWord to clear)
                if (inputRef.current) {
                    const cursorPos = inputState.selection.start;
                    inputRef.current.setTextAndSelection(inputState.text, {
                        start: cursorPos,
                        end: cursorPos
                    });
                }
                return true;
            }
        }

        // Handle Escape for abort when no suggestions are visible
        if (event.key === 'Escape' && props.showAbortButton && props.onAbort && !isAborting) {
            handleAbortPress();
            return true;
        }

        if (event.key === 'ArrowUp' && navigateInputHistory('up')) {
            return true;
        }
        if (event.key === 'ArrowDown' && navigateInputHistory('down')) {
            return true;
        }

        // Original key handling
        if (Platform.OS === 'web') {
            // On mobile web (touch devices), Enter should insert a newline since
            // there's no Shift key available. Users send via the send button instead.
            // Use pointer:coarse media query instead of ontouchstart/maxTouchPoints
            // to avoid false positives on Windows touch-screen laptops with keyboards.
            const isTouchDevice = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;
            if (agentInputEnterToSend && event.key === 'Enter' && !event.shiftKey && !isTouchDevice) {
                if (hasContent) {
                    if (!props.isSendDisabled && !props.isSending && !voiceBusy) {
                        props.onSend();
                    }
                    return true; // Key was handled
                }
            }
            // Handle Shift+Tab for permission mode switching
            if (event.key === 'Tab' && event.shiftKey && props.onPermissionModeChange && availableModes.length > 0) {
                const currentIndex = availableModes.findIndex((mode) => mode.key === permissionModeKey);
                const nextIndex = ((currentIndex >= 0 ? currentIndex : 0) + 1) % availableModes.length;
                props.onPermissionModeChange(availableModes[nextIndex]);
                hapticsLight();
                return true; // Key was handled, prevent default tab behavior
            }

        }
        return false; // Key was not handled
    }, [suggestions, moveUp, moveDown, selected, handleSuggestionSelect, props.showAbortButton, props.onAbort, isAborting, handleAbortPress, navigateInputHistory, agentInputEnterToSend, props.value, props.onSend, props.onPermissionModeChange, availableModes, permissionModeKey, props.isSendDisabled, props.isSending, voiceBusy, hasContent]);

    const connectionStatusParts = React.useMemo(() => {
        const segments = props.connectionStatus?.text.split(' · ') ?? [];
        if (segments.length < 3) {
            return { primary: props.connectionStatus?.text ?? '', detail: '' };
        }
        return {
            primary: segments.slice(0, 2).join(' · '),
            detail: segments.slice(2).join(' · '),
        };
    }, [props.connectionStatus?.text]);

    return (
        <View style={[
            styles.container,
            { paddingHorizontal: screenWidth > 700 ? 12 : 8 }
        ]}>
            <View style={[
                styles.innerContainer,
                { maxWidth: layout.maxWidth }
            ]}>
                {/* Autocomplete suggestions overlay */}
                {suggestions.length > 0 && (
                    <View style={[
                        styles.autocompleteOverlay,
                        { paddingHorizontal: screenWidth > 700 ? 0 : 8 }
                    ]}>
                        <AgentInputAutocomplete
                            suggestions={suggestions.map(s => {
                                const Component = s.component;
                                return <Component key={s.key} />;
                            })}
                            selectedIndex={selected}
                            onSelect={handleSuggestionSelect}
                            itemHeight={48}
                        />
                    </View>
                )}

                {showInputHistory && (props.inputHistory?.length ?? 0) > 0 && (
                    <>
                        <TouchableWithoutFeedback onPress={() => setShowInputHistory(false)}>
                            <View style={styles.overlayBackdrop} />
                        </TouchableWithoutFeedback>
                        <View style={styles.settingsOverlay}>
                            <FloatingOverlay maxHeight={320} keyboardShouldPersistTaps="always">
                                <View style={{ paddingVertical: 8 }}>
                                    <Text style={{
                                        paddingHorizontal: 16,
                                        paddingVertical: 6,
                                        color: theme.colors.textSecondary,
                                        fontSize: theme.typography.caption.fontSize,
                                        fontWeight: '600',
                                        ...Typography.default('semiBold'),
                                    }}>
                                        Recent inputs
                                    </Text>
                                    {props.inputHistory?.slice(0, 12).map((entry, index) => (
                                        <Pressable
                                            key={`${index}:${entry}`}
                                            accessibilityRole="button"
                                            accessibilityLabel={`Use recent input ${index + 1}`}
                                            onPress={() => {
                                                historyIndexRef.current = index;
                                                historyDraftRef.current = props.value;
                                                setInputFromHistory(entry);
                                                setShowInputHistory(false);
                                                inputRef.current?.focus();
                                                hapticsLight();
                                            }}
                                            style={({ pressed }) => ({
                                                paddingHorizontal: 16,
                                                paddingVertical: 10,
                                                backgroundColor: pressed ? theme.colors.surfacePressed : 'transparent',
                                            })}
                                        >
                                            <Text numberOfLines={2} style={{
                                                color: theme.colors.text,
                                                fontSize: theme.typography.label.fontSize,
                                                lineHeight: theme.typography.label.lineHeight,
                                                ...Typography.default(),
                                            }}>
                                                {entry}
                                            </Text>
                                        </Pressable>
                                    ))}
                                </View>
                            </FloatingOverlay>
                        </View>
                    </>
                )}

                {/* Settings overlay */}
                {showSettings && (
                    <>
                        <TouchableWithoutFeedback onPress={() => setShowSettings(false)}>
                            <View style={styles.overlayBackdrop} />
                        </TouchableWithoutFeedback>
                        <View style={[
                            styles.settingsOverlay,
                            { paddingHorizontal: screenWidth > 700 ? 0 : 8 }
                        ]}>
                            <FloatingOverlay maxHeight={400} keyboardShouldPersistTaps="always">
                                {hasCodexControls && <CodexControls preferences={props.codexPreferences!} onChange={props.onCodexPreferencesChange!}
                                    efforts={availableEffortLevels} effort={props.effortLevel} onEffortChange={props.onEffortLevelChange} serviceTiers={props.modelMode?.supportedServiceTiers} />}
                                {/* Permission Mode Section */}
                                <View style={styles.overlaySection}>
                                    <Text style={styles.overlaySectionTitle}>
                                        {isCodex ? t('agentInput.codexPermissionMode.title') : t('agentInput.permissionMode.title')}
                                    </Text>
                                    {availableModes.map((mode) => {
                                        const isSelected = permissionModeKey === mode.key;

                                        return (
                                            <Pressable
                                                key={mode.key}
                                                onPress={() => handleSettingsSelect(mode)}
                                                style={({ pressed }) => ({
                                                    flexDirection: 'row',
                                                    alignItems: 'center',
                                                    paddingHorizontal: 16,
                                                    paddingVertical: 8,
                                                    backgroundColor: pressed ? theme.colors.surfacePressed : 'transparent'
                                                })}
                                            >
                                                <View style={{
                                                    width: 16,
                                                    height: 16,
                                                    borderRadius: 8,
                                                    borderWidth: 2,
                                                    borderColor: isSelected ? theme.colors.radio.active : theme.colors.radio.inactive,
                                                    alignItems: 'center',
                                                    justifyContent: 'center',
                                                    marginRight: 12
                                                }}>
                                                    {isSelected && (
                                                        <View style={{
                                                            width: 6,
                                                            height: 6,
                                                            borderRadius: 3,
                                                            backgroundColor: theme.colors.radio.dot
                                                        }} />
                                                    )}
                                                </View>
                                                <View style={{ flex: 1 }}>
                                                    <Text style={{
                                                        fontSize: theme.typography.label.fontSize,
                                                        color: isSelected ? theme.colors.radio.active : theme.colors.text,
                                                        ...Typography.default()
                                                    }}>
                                                        {withSandboxSuffix(mode.name, mode.key)}
                                                    </Text>
                                                    {!!mode.description && (
                                                        <Text style={{
                                                            fontSize: theme.typography.caption.fontSize,
                                                            color: theme.colors.textSecondary,
                                                            ...Typography.default()
                                                        }}>
                                                            {mode.description}
                                                        </Text>
                                                    )}
                                                </View>
                                            </Pressable>
                                        );
                                    })}
                                </View>

                                {/* Divider */}
                                <View style={{
                                    height: 1,
                                    backgroundColor: theme.colors.divider,
                                    marginHorizontal: 16
                                }} />

                                {/* Model Section */}
                                <View style={{ paddingVertical: 8 }}>
                                    <Text style={{
                                        fontSize: theme.typography.caption.fontSize,
                                        fontWeight: '600',
                                        color: theme.colors.textSecondary,
                                        paddingHorizontal: 16,
                                        paddingBottom: 4,
                                        ...Typography.default('semiBold')
                                    }}>
                                        {t('agentInput.model.title')}
                                    </Text>
                                    {availableModels.length > 0 ? (
                                        availableModels.map((model) => {
                                            const isSelected = props.modelMode?.key === model.key;

                                            return (
                                                <Pressable
                                                    key={model.key}
                                                    onPress={() => {
                                                        hapticsLight();
                                                        props.onModelModeChange?.(model);
                                                        setShowSettings(false);
                                                    }}
                                                    style={({ pressed }) => ({
                                                        flexDirection: 'row',
                                                        alignItems: 'center',
                                                        paddingHorizontal: 16,
                                                        paddingVertical: 8,
                                                        backgroundColor: pressed ? theme.colors.surfacePressed : 'transparent'
                                                    })}
                                                >
                                                    <View style={{
                                                        width: 16,
                                                        flexShrink: 0,
                                                        height: 16,
                                                        borderRadius: 8,
                                                        borderWidth: 2,
                                                        borderColor: isSelected ? theme.colors.radio.active : theme.colors.radio.inactive,
                                                        alignItems: 'center',
                                                        justifyContent: 'center',
                                                        marginRight: 12
                                                    }}>
                                                        {isSelected && (
                                                            <View style={{
                                                                width: 6,
                                                                height: 6,
                                                                borderRadius: 3,
                                                                backgroundColor: theme.colors.radio.dot
                                                            }} />
                                                        )}
                                                    </View>
                                                    <View style={{ flex: 1, minWidth: 0 }}>
                                                        <Text style={{
                                                            fontSize: theme.typography.label.fontSize,
                                                            color: isSelected ? theme.colors.radio.active : theme.colors.text,
                                                            ...Typography.default()
                                                        }}>
                                                            {model.name}
                                                        </Text>
                                                        {!!model.description && (
                                                            <Text style={{
                                                                fontSize: theme.typography.caption.fontSize,
                                                                color: theme.colors.textSecondary,
                                                                ...Typography.default()
                                                            }}>
                                                                {model.description}
                                                            </Text>
                                                        )}
                                                    </View>
                                                </Pressable>
                                            );
                                        })
                                    ) : (
                                        <Text style={{
                                            fontSize: theme.typography.small.fontSize,
                                            color: theme.colors.textSecondary,
                                            paddingHorizontal: 16,
                                            paddingVertical: 8,
                                            ...Typography.default()
                                        }}>
                                            {t('agentInput.model.configureInCli')}
                                        </Text>
                                    )}
                                </View>

                                {/* Effort Level Section */}
                                {!hasCodexControls && availableEffortLevels.length > 0 && props.onEffortLevelChange && (
                                    <>
                                        <View style={{
                                            height: 1,
                                            backgroundColor: theme.colors.divider,
                                            marginHorizontal: 16
                                        }} />
                                        <View style={{ paddingVertical: 8 }}>
                                            <Text style={{
                                                fontSize: theme.typography.caption.fontSize,
                                                fontWeight: '600',
                                                color: theme.colors.textSecondary,
                                                paddingHorizontal: 16,
                                                paddingBottom: 4,
                                                ...Typography.default('semiBold')
                                            }}>
                                                {t('agentInput.effort.title')}
                                            </Text>
                                            {availableEffortLevels.map((level) => {
                                                const isSelected = props.effortLevel?.key === level.key;

                                                return (
                                                    <Pressable
                                                        key={level.key}
                                                        onPress={() => {
                                                            hapticsLight();
                                                            props.onEffortLevelChange?.(level);
                                                            setShowSettings(false);
                                                        }}
                                                        style={({ pressed }) => ({
                                                            flexDirection: 'row',
                                                            alignItems: 'center',
                                                            paddingHorizontal: 16,
                                                            paddingVertical: 8,
                                                            backgroundColor: pressed ? theme.colors.surfacePressed : 'transparent'
                                                        })}
                                                    >
                                                        <View style={{
                                                            width: 16,
                                                            flexShrink: 0,
                                                            height: 16,
                                                            borderRadius: 8,
                                                            borderWidth: 2,
                                                            borderColor: isSelected ? theme.colors.radio.active : theme.colors.radio.inactive,
                                                            alignItems: 'center',
                                                            justifyContent: 'center',
                                                            marginRight: 12
                                                        }}>
                                                            {isSelected && (
                                                                <View style={{
                                                                    width: 6,
                                                                    height: 6,
                                                                    borderRadius: 3,
                                                                    backgroundColor: theme.colors.radio.dot
                                                                }} />
                                                            )}
                                                        </View>
                                                        <View style={{ flex: 1, minWidth: 0 }}>
                                                            <Text style={{
                                                                fontSize: theme.typography.label.fontSize,
                                                                color: isSelected ? theme.colors.radio.active : theme.colors.text,
                                                                ...Typography.default()
                                                            }}>
                                                                {level.name}
                                                            </Text>
                                                            {!!level.description && (
                                                                <Text style={{
                                                                    fontSize: theme.typography.caption.fontSize,
                                                                    color: theme.colors.textSecondary,
                                                                    ...Typography.default()
                                                                }}>
                                                                    {level.description}
                                                                </Text>
                                                            )}
                                                        </View>
                                                    </Pressable>
                                                );
                                            })}
                                        </View>
                                    </>
                                )}
                            </FloatingOverlay>
                        </View>
                    </>
                )}

                {/* Connection status, context warning, and permission mode */}
                {(props.connectionStatus || contextWarning || (displayPermissionMode && permissionModeKey !== 'default')) && (
                    <View style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        paddingHorizontal: 16,
                        paddingBottom: 4,
                        minHeight: 20, // Fixed minimum height to prevent jumping
                    }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1, minWidth: 0, gap: 11 }}>
                            {props.connectionStatus && (
                                <>
                                    <View
                                        style={{ flexDirection: 'row', alignItems: 'center', flexShrink: 1, minWidth: 0, gap: 5 }}
                                        accessibilityRole="text"
                                        accessibilityLiveRegion="polite"
                                        accessibilityLabel={props.connectionStatus.text}
                                    >
                                        <StatusDot
                                            color={props.connectionStatus.dotColor}
                                            isPulsing={props.connectionStatus.isPulsing}
                                            size={6}
                                        />
                                        <Text style={{
                                            flexShrink: 0,
                                            fontSize: theme.typography.caption.fontSize,
                                            color: props.connectionStatus.color,
                                            ...Typography.default()
                                        }}>
                                            {connectionStatusParts.primary}
                                        </Text>
                                        {!!connectionStatusParts.detail && (
                                            <Text
                                                numberOfLines={1}
                                                ellipsizeMode="tail"
                                                style={{
                                                    flexShrink: 1,
                                                    minWidth: 0,
                                                    fontSize: theme.typography.caption.fontSize,
                                                    color: props.connectionStatus.color,
                                                    ...Typography.default()
                                                }}
                                            >
                                                {' · '}{connectionStatusParts.detail}
                                            </Text>
                                        )}
                                    </View>
                                    {/* CLI Status - only shown when provided (wizard only) */}
                                    {props.connectionStatus.cliStatus && (
                                        <>
                                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                                                <Text style={{
                                                    fontSize: theme.typography.caption.fontSize,
                                                    color: props.connectionStatus.cliStatus.claude
                                                        ? theme.colors.success
                                                        : theme.colors.textDestructive,
                                                    ...Typography.default()
                                                }}>
                                                    {props.connectionStatus.cliStatus.claude ? '✓' : '✗'}
                                                </Text>
                                                <Text style={{
                                                    fontSize: theme.typography.caption.fontSize,
                                                    color: props.connectionStatus.cliStatus.claude
                                                        ? theme.colors.success
                                                        : theme.colors.textDestructive,
                                                    ...Typography.default()
                                                }}>
                                                    claude
                                                </Text>
                                            </View>
                                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                                                <Text style={{
                                                    fontSize: theme.typography.caption.fontSize,
                                                    color: props.connectionStatus.cliStatus.codex
                                                        ? theme.colors.success
                                                        : theme.colors.textDestructive,
                                                    ...Typography.default()
                                                }}>
                                                    {props.connectionStatus.cliStatus.codex ? '✓' : '✗'}
                                                </Text>
                                                <Text style={{
                                                    fontSize: theme.typography.caption.fontSize,
                                                    color: props.connectionStatus.cliStatus.codex
                                                        ? theme.colors.success
                                                        : theme.colors.textDestructive,
                                                    ...Typography.default()
                                                }}>
                                                    codex
                                                </Text>
                                            </View>
                                        </>
                                    )}
                                </>
                            )}
                            {contextWarning && (
                                <Text style={{
                                    fontSize: theme.typography.caption.fontSize,
                                    color: contextWarning.color,
                                    marginLeft: props.connectionStatus ? 8 : 0,
                                    ...Typography.default()
                                }}>
                                    {props.connectionStatus ? '• ' : ''}{contextWarning.text}
                                </Text>
                            )}
                        </View>
                        {/* Permission badge — only shown when non-default */}
                        {displayPermissionMode && permissionModeKey !== 'default' && (() => {
                            const permColor = isSandboxedYoloMode ? '#4169E1' :
                                permissionModeKey === 'acceptEdits' ? theme.colors.permission.acceptEdits :
                                    permissionModeKey === 'bypassPermissions' ? theme.colors.permission.bypass :
                                        permissionModeKey === 'plan' ? theme.colors.permission.plan :
                                            permissionModeKey === 'read-only' ? theme.colors.permission.readOnly :
                                                permissionModeKey === 'safe-yolo' ? theme.colors.permission.safeYolo :
                                                    permissionModeKey === 'yolo' ? theme.colors.permission.yolo :
                                                        theme.colors.textSecondary;
                            const permIcon: 'play-forward' | 'pause' =
                                permissionModeKey === 'plan' || permissionModeKey === 'read-only'
                                    ? 'pause' : 'play-forward';
                            return (
                                <View style={{ flexDirection: 'row', alignItems: 'center', flexShrink: 0, marginLeft: 8, gap: 4 }}>
                                    <Ionicons name={permIcon} size={11} color={permColor} />
                                    <Text style={{
                                        fontSize: theme.typography.caption.fontSize,
                                        color: permColor,
                                        ...Typography.default()
                                    }}>
                                        {withSandboxSuffix(displayPermissionMode.name, permissionModeKey)}
                                    </Text>
                                </View>
                            );
                        })()}
                    </View>
                )}

                {/* Box 1: Context Information (Machine + Path) - Only show if either exists */}
                {(props.machineName !== undefined || props.currentPath) && (
                    <View style={{
                        backgroundColor: theme.colors.surfacePressed,
                        borderRadius: 12,
                        padding: 8,
                        marginBottom: 8,
                        gap: 4,
                    }}>
                        {/* Machine chip */}
                        {props.machineName !== undefined && props.onMachineClick && (
                            <Pressable
                                onPress={() => {
                                    hapticsLight();
                                    props.onMachineClick?.();
                                }}
                                hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                                style={(p) => ({
                                    flexDirection: 'row',
                                    alignItems: 'center',
                                    borderRadius: Platform.select({ default: 16, android: 20 }),
                                    paddingHorizontal: 10,
                                    paddingVertical: 6,
                                    minHeight: 44,
                                    height: 44,
                                    opacity: p.pressed ? 0.7 : 1,
                                    gap: 6,
                                })}
                            >
                                <Ionicons
                                    name="desktop-outline"
                                    size={14}
                                    color={theme.colors.textSecondary}
                                />
                                <Text style={{
                                    fontSize: theme.typography.small.fontSize,
                                    color: theme.colors.text,
                                    fontWeight: '600',
                                    ...Typography.default('semiBold'),
                                }}>
                                    {props.machineName === null ? t('agentInput.noMachinesAvailable') : props.machineName}
                                </Text>
                            </Pressable>
                        )}

                        {/* Path chip */}
                        {props.currentPath && props.onPathClick && (
                            <Pressable
                                onPress={() => {
                                    hapticsLight();
                                    props.onPathClick?.();
                                }}
                                hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                                style={(p) => ({
                                    flexDirection: 'row',
                                    alignItems: 'center',
                                    borderRadius: Platform.select({ default: 16, android: 20 }),
                                    paddingHorizontal: 10,
                                    paddingVertical: 6,
                                    minHeight: 44,
                                    height: 44,
                                    opacity: p.pressed ? 0.7 : 1,
                                    gap: 6,
                                })}
                            >
                                <Ionicons
                                    name="folder-outline"
                                    size={14}
                                    color={theme.colors.textSecondary}
                                />
                                <Text style={{
                                    fontSize: theme.typography.small.fontSize,
                                    color: theme.colors.text,
                                    fontWeight: '600',
                                    ...Typography.default('semiBold'),
                                }}>
                                    {props.currentPath}
                                </Text>
                            </Pressable>
                        )}
                    </View>
                )}

                {/* Box 2: Action Area (Input + Send) */}
                <View style={styles.unifiedPanel}>
                    {showProminentMobileWebImageButton && (
                        <View style={{ paddingHorizontal: 8, paddingTop: 8, paddingBottom: hasImages ? 0 : 4 }}>
                            <Pressable
                                onPress={handlePickImages}
                                style={(p) => ({
                                    flexDirection: 'row',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    gap: 8,
                                    borderRadius: 12,
                                    borderWidth: 1,
                                    borderColor: theme.colors.divider,
                                    backgroundColor: theme.colors.surfaceHigh,
                                    paddingHorizontal: 12,
                                    paddingVertical: 10,
                                    opacity: p.pressed ? 0.75 : 1,
                                })}
                            >
                                <Ionicons
                                    name="image-outline"
                                    size={18}
                                    color={theme.colors.button.secondary.tint}
                                />
                                <Text style={{
                                    fontSize: theme.typography.label.fontSize,
                                    color: theme.colors.text,
                                    fontWeight: '600',
                                    ...Typography.default('semiBold'),
                                }}>
                                    {hasImages ? t('agentInput.addMoreImages') : t('agentInput.attachImage')}
                                </Text>
                            </Pressable>
                        </View>
                    )}
                    {/* Image attachments preview */}
                    {props.images && props.images.length > 0 && (
                        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 8, paddingTop: 8 }}>
                            {props.images.map((img, index) => (
                                <View key={index} style={{ position: 'relative' }}>
                                    <RNImage
                                        source={{ uri: `data:${img.mediaType};base64,${img.previewData ?? img.data}` }}
                                        style={{ width: 64, height: 64, borderRadius: 8 }}
                                        resizeMode="cover"
                                    />
                                    <Pressable
                                        onPress={() => props.onRemoveImage?.(index)}
                                        style={{
                                            position: 'absolute',
                                            top: -6,
                                            right: -6,
                                            width: 20,
                                            height: 20,
                                            borderRadius: 10,
                                            backgroundColor: theme.colors.surfaceHigh,
                                            alignItems: 'center',
                                            justifyContent: 'center',
                                        }}
                                    >
                                        <Ionicons name="close" size={14} color={theme.colors.text} />
                                    </Pressable>
                                </View>
                            ))}
                        </View>
                    )}
                    {props.attachmentPreview}
                    <VoiceInputStatus feedback={voiceFeedback} />
                    {/* Input field */}
                    <View style={[styles.inputContainer, props.minHeight ? { minHeight: props.minHeight } : undefined]}>
                        <MultiTextInput
                            ref={inputRef}
                            value={props.value}
                            paddingTop={Platform.OS === 'web' ? 11 : 8}
                            paddingBottom={Platform.OS === 'web' ? 11 : 8}
                            onChangeText={handleComposerTextChange}
                            placeholder={props.placeholder}
                            onKeyPress={handleKeyPress}
                            onStateChange={handleInputStateChange}
                            maxHeight={120}
                            {...(Platform.OS === 'web' && props.onPasteImages ? { onPasteImages: handleIncomingImages } : {})}
                        />
                    </View>

                    {/* Action buttons below input */}
                    <View style={styles.actionButtonsContainer}>
                        <View style={{ flexDirection: 'column', flex: 1, gap: 2 }}>
                            {/* Row 1: Settings, Profile (FIRST), Agent, Abort, Git Status */}
                            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                                <View style={[styles.actionButtonsLeft, isMobileWeb && { gap: 0, flexWrap: 'wrap' }]}>

                                {(props.inputHistory?.length ?? 0) > 0 && (
                                    <Pressable
                                        accessibilityRole="button"
                                        accessibilityLabel="Recent inputs"
                                        onPress={() => {
                                            hapticsLight();
                                            setShowSettings(false);
                                            setShowInputHistory((visible) => !visible);
                                        }}
                                        hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                                        style={(p) => ({
                                            flexDirection: 'row',
                                            alignItems: 'center',
                                            borderRadius: Platform.select({ default: 16, android: 20 }),
                                            paddingHorizontal: 8,
                                            paddingVertical: 6,
                                            justifyContent: 'center',
                                            minWidth: 44,
                                            height: 44,
                                            opacity: p.pressed ? 0.7 : 1,
                                        })}
                                    >
                                        <Ionicons name="time-outline" size={18} color={theme.colors.button.secondary.tint} />
                                    </Pressable>
                                )}

                                {/* Image picker button (native always; web also, since paste isn't reliable on mobile browsers) */}
                                {props.onPickFiles && <Pressable accessibilityRole="button" accessibilityLabel="添加附件" onPress={props.onPickFiles}
                                    style={{ minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' }}>
                                    <Ionicons name="attach-outline" size={20} color={theme.colors.button.secondary.tint} />
                                </Pressable>}
                                {props.onPasteImages && !showProminentMobileWebImageButton && (
                                    <Pressable
                                        accessibilityRole="button"
                                        accessibilityLabel="Attach image"
                                        onPress={handlePickImages}
                                        hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                                        style={(p) => ({
                                            flexDirection: 'row',
                                            alignItems: 'center',
                                            borderRadius: Platform.select({ default: 16, android: 20 }),
                                            paddingHorizontal: 8,
                                            paddingVertical: 6,
                                            justifyContent: 'center',
                                            minWidth: 44,
                                            height: 44,
                                            opacity: p.pressed ? 0.7 : 1,
                                        })}
                                    >
                                        <Ionicons
                                            name="image-outline"
                                            size={18}
                                            color={theme.colors.button.secondary.tint}
                                        />
                                    </Pressable>
                                )}

                                <VoiceInput value={props.value} onChangeText={props.onChangeText} onBusyChange={setVoiceBusy}
                                    onFeedbackChange={setVoiceFeedback} scope={props.historyKey ?? props.sessionId} />

                                {/* Settings button */}
                                {(props.onPermissionModeChange || hasCodexControls) && (
                                    <Pressable
                                        accessibilityRole="button"
                                        accessibilityLabel="Open session settings"
                                        accessibilityState={{ expanded: showSettings }}
                                        onPress={handleSettingsPress}
                                        hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                                        style={(p) => ({
                                            flexDirection: 'row',
                                            alignItems: 'center',
                                            borderRadius: Platform.select({ default: 16, android: 20 }),
                                            paddingHorizontal: 8,
                                            paddingVertical: 6,
                                            justifyContent: 'center',
                                            minWidth: 44,
                                            height: 44,
                                            opacity: p.pressed ? 0.7 : 1,
                                        })}
                                    >
                                        <Octicons
                                            name={'gear'}
                                            size={16}
                                            color={theme.colors.button.secondary.tint}
                                        />
                                    </Pressable>
                                )}

                                {/* Agent selector button */}
                                {props.agentType && props.onAgentClick && (
                                    <Pressable
                                        accessibilityRole="button"
                                        accessibilityLabel="Select CLI agent"
                                        onPress={() => {
                                            hapticsLight();
                                            props.onAgentClick?.();
                                        }}
                                        hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                                        style={(p) => ({
                                            flexDirection: 'row',
                                            alignItems: 'center',
                                            borderRadius: Platform.select({ default: 16, android: 20 }),
                                            paddingHorizontal: 10,
                                            paddingVertical: 6,
                                            justifyContent: 'center',
                                            minWidth: 44,
                                            height: 44,
                                            opacity: p.pressed ? 0.7 : 1,
                                            gap: 6,
                                        })}
                                    >
                                        <Octicons
                                            name="cpu"
                                            size={14}
                                            color={theme.colors.button.secondary.tint}
                                        />
                                        <Text style={{
                                            fontSize: theme.typography.small.fontSize,
                                            color: theme.colors.button.secondary.tint,
                                            fontWeight: '600',
                                            ...Typography.default('semiBold'),
                                        }}>
                                            {props.agentType === 'codex' ? t('agentInput.agent.codex') : t('agentInput.agent.claude')}
                                        </Text>
                                    </Pressable>
                                )}

                                {/* Abort button */}
                                {props.onAbort && (
                                    <Shaker ref={shakerRef}>
                                        <Pressable
                                            accessibilityRole="button"
                                            accessibilityLabel="Stop current response"
                                            style={(p) => ({
                                                flexDirection: 'row',
                                                alignItems: 'center',
                                                borderRadius: Platform.select({ default: 16, android: 20 }),
                                                paddingHorizontal: 8,
                                                paddingVertical: 6,
                                                justifyContent: 'center',
                                                minWidth: 44,
                                                height: 44,
                                                opacity: p.pressed ? 0.7 : 1,
                                            })}
                                            hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                                            onPress={handleAbortPress}
                                            disabled={isAborting}
                                        >
                                            {isAborting ? (
                                                <ActivityIndicator
                                                    size="small"
                                                    color={theme.colors.button.secondary.tint}
                                                />
                                            ) : (
                                                <Ionicons
                                                    name="stop"
                                                    size={16}
                                                    color={theme.colors.button.secondary.tint}
                                                />
                                            )}
                                        </Pressable>
                                    </Shaker>
                                )}

                                {/* Git Status Badge */}
                                <GitStatusButton sessionId={props.sessionId} onPress={props.onFileViewerPress} />
                                </View>

                                {/* Send/Voice button - aligned with first row */}
                                <View
                                    style={[
                                        styles.sendButton,
                                        { width: 44, height: 44, borderRadius: 22, marginLeft: isMobileWeb ? 6 : 8 },
                                        (hasContent || props.isSending)
                                            ? styles.sendButtonActive
                                            : styles.sendButtonInactive
                                    ]}
                                >
                                    <Pressable
                                        accessibilityRole="button"
                                        accessibilityLabel={props.isSending ? "Sending message" : "Send message"}
                                        style={(p) => ({
                                            width: '100%',
                                            height: '100%',
                                            alignItems: 'center',
                                            justifyContent: 'center',
                                            opacity: p.pressed ? 0.7 : 1,
                                        })}
                                        hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                                        onPress={handleSendPress}
                                        disabled={!canPressSendButton}
                                    >
                                        {props.isSending ? (
                                            <ActivityIndicator
                                                size="small"
                                                color={theme.colors.button.primary.tint}
                                            />
                                        ) : hasContent ? (
                                            <Octicons
                                                name="arrow-up"
                                                size={16}
                                                color={theme.colors.button.primary.tint}
                                                style={[
                                                    styles.sendButtonIcon,
                                                    { marginTop: Platform.OS === 'web' ? 2 : 0 }
                                                ]}
                                            />
                                        ) : (
                                            <Octicons
                                                name="arrow-up"
                                                size={16}
                                                color={theme.colors.button.primary.tint}
                                                style={[
                                                    styles.sendButtonIcon,
                                                    { marginTop: Platform.OS === 'web' ? 2 : 0 }
                                                ]}
                                            />
                                        )}
                                    </Pressable>
                                </View>
                            </View>
                        </View>
                    </View>
                </View>
            </View>
        </View>
    );
}));

// Git Status Button Component
function GitStatusButton({ sessionId, onPress }: { sessionId?: string, onPress?: () => void }) {
    const hasMeaningfulGitStatus = useHasMeaningfulGitStatus(sessionId || '');
    const styles = stylesheet;
    const { theme } = useUnistyles();

    if (!sessionId || !onPress) {
        return null;
    }

    return (
        <Pressable
            style={(p) => ({
                flexDirection: 'row',
                alignItems: 'center',
                borderRadius: Platform.select({ default: 16, android: 20 }),
                paddingHorizontal: 8,
                paddingVertical: 6,
                minWidth: 44,
                height: 44,
                opacity: p.pressed ? 0.7 : 1,
                flex: 1,
                overflow: 'hidden',
            })}
            hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
            onPress={() => {
                hapticsLight();
                onPress?.();
            }}
        >
            {hasMeaningfulGitStatus ? (
                <GitStatusBadge sessionId={sessionId} />
            ) : (
                <Octicons
                    name="git-branch"
                    size={16}
                    color={theme.colors.button.secondary.tint}
                />
            )}
        </Pressable>
    );
}
