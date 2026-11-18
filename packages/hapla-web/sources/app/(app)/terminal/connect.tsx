import React from 'react';
import { Platform, Pressable, ScrollView, View, useWindowDimensions } from 'react-native';
import { useRouter } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { RoundButton } from '@/components/RoundButton';
import { useConnectTerminal } from '@/hooks/useConnectTerminal';
import { t } from '@/text';

export default function TerminalConnectScreen() {
    const router = useRouter();
    const { theme } = useUnistyles();
    const insets = useSafeAreaInsets();
    const { width } = useWindowDimensions();
    const [publicKey, setPublicKey] = React.useState<string | null>(null);
    const [hashProcessed, setHashProcessed] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const compact = width < 640;
    const { processAuthUrl, isLoading } = useConnectTerminal({
        showErrorModal: false,
        onSuccess: () => router.replace('/'),
        onError: (cause) => {
            const message = cause instanceof Error ? cause.message : String(cause);
            setError(message || t('modals.failedToConnectTerminal'));
        },
    });

    React.useEffect(() => {
        if (Platform.OS !== 'web' || typeof window === 'undefined' || hashProcessed) return;
        const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
        const key = params.get('key')?.trim() || null;
        setPublicKey(key);
        window.history.replaceState(null, '', window.location.pathname + window.location.search);
        setHashProcessed(true);
    }, [hashProcessed]);

    if (Platform.OS !== 'web') {
        return <ConnectionState icon="desktop-outline" title={t('terminal.webBrowserRequired')} description={t('terminal.webBrowserRequiredDescription')} />;
    }
    if (!hashProcessed) {
        return <ConnectionState title={t('terminal.processingConnection')} />;
    }
    if (!publicKey) {
        return <ConnectionState icon="link-outline" title={t('terminal.invalidConnectionLink')} description={t('terminal.invalidConnectionLinkDescription')} destructive />;
    }

    return (
        <ScrollView
            style={{ flex: 1, backgroundColor: theme.colors.groupped.background }}
            contentContainerStyle={{
                minHeight: '100%',
                alignItems: 'center',
                justifyContent: compact ? 'flex-start' : 'center',
                paddingTop: compact ? 18 : 40,
                paddingBottom: Math.max(insets.bottom, 24),
                paddingHorizontal: compact ? 16 : 28,
            }}
        >
            <View style={{ width: '100%', maxWidth: 620 }}>
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Back"
                    onPress={() => router.back()}
                    style={({ pressed }) => ({
                        width: 40,
                        height: 40,
                        marginBottom: 12,
                        marginLeft: -8,
                        borderRadius: 12,
                        alignItems: 'center',
                        justifyContent: 'center',
                        backgroundColor: pressed ? theme.colors.surfacePressed : 'transparent',
                    })}
                >
                    <Ionicons name="arrow-back" size={21} color={theme.colors.text} />
                </Pressable>

                <View style={{
                    borderRadius: compact ? 16 : 20,
                    borderWidth: 1,
                    borderColor: theme.colors.divider,
                    backgroundColor: theme.colors.surface,
                    paddingHorizontal: compact ? 20 : 32,
                    paddingVertical: compact ? 24 : 32,
                }}>
                    <View style={{
                        width: 48,
                        height: 48,
                        borderRadius: 14,
                        backgroundColor: theme.colors.surfaceHigh,
                        alignItems: 'center',
                        justifyContent: 'center',
                        marginBottom: 22,
                    }}>
                        <Ionicons name="terminal-outline" size={25} color={theme.colors.text} />
                    </View>
                    <Text style={{ fontSize: compact ? theme.typography.title.fontSize : theme.typography.display.fontSize, lineHeight: compact ? 31 : 36, color: theme.colors.text, ...Typography.default('semiBold') }}>
                        {t('terminal.connectTerminal')}
                    </Text>
                    <Text style={{ marginTop: 10, fontSize: theme.typography.body.fontSize, lineHeight: theme.typography.body.lineHeight, color: theme.colors.textSecondary, ...Typography.default() }}>
                        {t('terminal.terminalRequestDescription')}
                    </Text>

                    <View style={{ marginTop: 28, borderTopWidth: 1, borderTopColor: theme.colors.divider }}>
                        <DetailRow icon="key-outline" label={t('terminal.publicKey')} value={`${publicKey.slice(0, 12)}...`} />
                        <DetailRow icon="lock-closed-outline" label={t('terminal.encryption')} value={t('terminal.endToEndEncrypted')} last />
                    </View>

                    {error && (
                        <View accessibilityRole="alert" style={{
                            marginTop: 18,
                            borderRadius: 12,
                            paddingHorizontal: 14,
                            paddingVertical: 12,
                            flexDirection: 'row',
                            gap: 10,
                            backgroundColor: theme.colors.box.error.background,
                        }}>
                            <Ionicons name="alert-circle-outline" size={19} color={theme.colors.box.error.text} />
                            <View style={{ flex: 1 }}>
                                <Text style={{ fontSize: theme.typography.label.fontSize, color: theme.colors.box.error.text, ...Typography.default('semiBold') }}>
                                    {t('modals.failedToConnectTerminal')}
                                </Text>
                                <Text selectable style={{ marginTop: 3, fontSize: theme.typography.caption.fontSize, lineHeight: theme.typography.caption.lineHeight, color: theme.colors.box.error.text, ...Typography.default() }}>
                                    {error}
                                </Text>
                            </View>
                        </View>
                    )}

                    <View style={{ marginTop: 24, gap: 10 }}>
                        <RoundButton
                            title={isLoading ? t('terminal.connecting') : t('terminal.acceptConnection')}
                            onPress={() => {
                                setError(null);
                                void processAuthUrl(`hapla://terminal?${publicKey}`);
                            }}
                            disabled={isLoading}
                            loading={isLoading}
                            size="large"
                            style={{ width: '100%' }}
                        />
                        <RoundButton
                            title={t('terminal.reject')}
                            onPress={() => router.back()}
                            disabled={isLoading}
                            display="inverted"
                            size="normal"
                            style={{ width: '100%' }}
                        />
                    </View>
                </View>

                <View style={{ paddingHorizontal: 8, paddingTop: 18, flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
                    <Ionicons name="shield-checkmark-outline" size={18} color={theme.colors.textSecondary} />
                    <Text style={{ flex: 1, color: theme.colors.textSecondary, fontSize: theme.typography.caption.fontSize, lineHeight: theme.typography.caption.lineHeight, ...Typography.default() }}>
                        {t('terminal.securityFooter')}
                    </Text>
                </View>
            </View>
        </ScrollView>
    );
}

function DetailRow(props: { icon: React.ComponentProps<typeof Ionicons>['name']; label: string; value: string; last?: boolean }) {
    const { theme } = useUnistyles();
    return (
        <View style={{ minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: 12, borderBottomWidth: props.last ? 0 : 1, borderBottomColor: theme.colors.divider }}>
            <Ionicons name={props.icon} size={19} color={theme.colors.textSecondary} />
            <Text style={{ flex: 1, fontSize: theme.typography.label.fontSize, color: theme.colors.text, ...Typography.default() }}>{props.label}</Text>
            <Text selectable numberOfLines={1} style={{ maxWidth: '48%', fontSize: theme.typography.code.fontSize, color: theme.colors.textSecondary, ...Typography.mono() }}>{props.value}</Text>
        </View>
    );
}

function ConnectionState(props: { title: string; description?: string; icon?: React.ComponentProps<typeof Ionicons>['name']; destructive?: boolean }) {
    const { theme } = useUnistyles();
    return (
        <View style={{ flex: 1, backgroundColor: theme.colors.groupped.background, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
            {props.icon && <Ionicons name={props.icon} size={30} color={props.destructive ? theme.colors.warningCritical : theme.colors.textSecondary} />}
            <Text style={{ marginTop: props.icon ? 16 : 0, color: theme.colors.text, fontSize: theme.typography.heading.fontSize, textAlign: 'center', ...Typography.default('semiBold') }}>{props.title}</Text>
            {props.description && <Text style={{ marginTop: 8, color: theme.colors.textSecondary, fontSize: theme.typography.label.fontSize, lineHeight: theme.typography.label.lineHeight, textAlign: 'center', maxWidth: 440, ...Typography.default() }}>{props.description}</Text>}
        </View>
    );
}
