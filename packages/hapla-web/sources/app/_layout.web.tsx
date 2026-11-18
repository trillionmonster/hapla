import 'react-native-quick-base64';
import '../theme.css';
import * as React from 'react';
import { Asset } from 'expo-asset';
import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { SafeAreaProvider, initialWindowMetrics } from 'react-native-safe-area-context';
import { Pressable, Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { AuthProvider } from '@/auth/AuthContext';
import { TokenStorage, type AuthCredentials } from '@/auth/tokenStorage';
import { ModalProvider } from '@/modal';
import { CommandPaletteProvider } from '@/components/CommandPalette/CommandPaletteProvider';
import { FaviconPermissionIndicator } from '@/components/web/FaviconPermissionIndicator';
import { WebReleaseMonitor } from '@/components/WebReleaseMonitor';
import { DownloadManager } from '@/components/downloads/DownloadManager.web';
import { syncRestore } from '@/sync/sync';
import sodium from '@/encryption/libsodium.lib';
import { initializeTranslations } from '@/text';
import { dismissWebBootstrapOverlay } from '@/utils/webBootstrap';

export { ErrorBoundary } from 'expo-router';

const LazySidebarNavigator = React.lazy(() => import('@/components/SidebarNavigator').then((module) => ({
    default: module.SidebarNavigator,
})));

const WEB_FONTS = {
    'IBMPlexSans-Regular': require('@/assets/fonts/IBMPlexSans-Regular.ttf'),
    'IBMPlexSans-Italic': require('@/assets/fonts/IBMPlexSans-Italic.ttf'),
    'IBMPlexSans-SemiBold': require('@/assets/fonts/IBMPlexSans-SemiBold.ttf'),
    'IBMPlexMono-Regular': require('@/assets/fonts/IBMPlexMono-Regular.ttf'),
    'IBMPlexMono-Italic': require('@/assets/fonts/IBMPlexMono-Italic.ttf'),
    'IBMPlexMono-SemiBold': require('@/assets/fonts/IBMPlexMono-SemiBold.ttf'),
    'BricolageGrotesque-Bold': require('@/assets/fonts/BricolageGrotesque-Bold.ttf'),
};
let criticalBootPromise: Promise<void> | null = null;
let optionalFontsRegistered = false;

function loadCriticalBootDependencies(): Promise<void> {
    if (!criticalBootPromise) {
        criticalBootPromise = Promise.all([
            sodium.ready,
            initializeTranslations(),
        ]).then(() => undefined).catch((error) => {
            // Do not retain a rejected promise if React remounts during recovery.
            criticalBootPromise = null;
            throw error;
        });
    }
    return criticalBootPromise;
}

function registerOptionalWebFonts(): void {
    if (optionalFontsRegistered || typeof FontFace === 'undefined') return;
    optionalFontsRegistered = true;
    // CSS requests only faces that the current screen uses. Optional display
    // keeps fallback metrics for this visit if a font arrives late: loading a
    // custom font must neither block auth nor move the reader's chat position.
    for (const [family, resource] of Object.entries(WEB_FONTS)) {
        try {
            const uri = Asset.fromModule(resource).uri;
            document.fonts.add(new FontFace(family, `url(${JSON.stringify(uri)})`, { display: 'optional' }));
        } catch { /* System fonts remain usable on browsers without this API. */ }
    }
}

function readDevCredentials(): AuthCredentials | null {
    if (!__DEV__) return null;
    const params = new URLSearchParams(window.location.search);
    const token = params.get('dev_token') || process.env.EXPO_PUBLIC_DEV_TOKEN;
    const secret = params.get('dev_secret') || process.env.EXPO_PUBLIC_DEV_SECRET;
    return token && secret ? { token, secret } : null;
}

function BootstrapHandoff() {
    React.useEffect(() => {
        // This component only commits with visible application or error UI.
        // Until then, exported HTML keeps its root-external recovery overlay.
        dismissWebBootstrapOverlay();
    }, []);
    return null;
}

export default function WebRootLayout() {
    const { theme } = useUnistyles();
    const [credentials, setCredentials] = React.useState<AuthCredentials | null | undefined>(undefined);
    const [bootError, setBootError] = React.useState<string | null>(null);
    const navigationTheme = React.useMemo(() => ({
        ...(theme.dark ? DarkTheme : DefaultTheme),
        colors: {
            ...(theme.dark ? DarkTheme.colors : DefaultTheme.colors),
            background: theme.colors.groupped.background,
        },
    }), [theme.colors.groupped.background, theme.dark]);

    React.useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                registerOptionalWebFonts();
                await loadCriticalBootDependencies();
                let nextCredentials = await TokenStorage.getCredentials();
                const devCredentials = readDevCredentials();
                if (devCredentials) {
                    await TokenStorage.setCredentials(devCredentials);
                    nextCredentials = devCredentials;
                    window.history.replaceState({}, '', window.location.pathname);
                }
                if (nextCredentials) await syncRestore(nextCredentials);
                if (!cancelled) setCredentials(nextCredentials);
            } catch (error) {
                if (!cancelled) setBootError(error instanceof Error ? error.message : 'Hapla could not initialize');
            }
        })();
        return () => { cancelled = true; };
    }, []);

    if (bootError) {
        return (
            <>
                <BootstrapHandoff />
                <View style={{ flex: 1, backgroundColor: theme.colors.surface, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
                    <View
                        accessibilityLiveRegion="assertive"
                        accessibilityLabel={`Hapla initialization failed: ${bootError}`}
                        style={{ width: '100%', maxWidth: 560, padding: 20, borderRadius: 12, borderWidth: 1, borderColor: theme.colors.divider, backgroundColor: theme.colors.surfaceHigh }}
                    >
                        <Text style={{ color: theme.colors.text, fontSize: theme.typography.body.fontSize, fontWeight: '600' }}>
                            Hapla could not initialize
                        </Text>
                        <Text selectable style={{ marginTop: 8, color: theme.colors.textSecondary, fontSize: theme.typography.small.fontSize, lineHeight: theme.typography.small.lineHeight }}>
                            {bootError}
                        </Text>
                        <Pressable
                            accessibilityRole="button"
                            accessibilityLabel="Retry starting Hapla"
                            onPress={() => window.location.reload()}
                            style={{ alignSelf: 'flex-start', minHeight: 44, marginTop: 16, paddingHorizontal: 16, borderRadius: 8, backgroundColor: theme.colors.button.primary.background, justifyContent: 'center' }}
                        >
                            <Text style={{ color: theme.colors.button.primary.tint, fontSize: theme.typography.label.fontSize, fontWeight: '600' }}>Retry</Text>
                        </Pressable>
                    </View>
                </View>
            </>
        );
    }

    if (credentials === undefined) {
        return (
            <View style={{ flex: 1, backgroundColor: theme.colors.surface, alignItems: 'center', justifyContent: 'center' }}>
                <View accessibilityLabel="Starting Hapla" style={{ width: 180, height: 3, borderRadius: 3, backgroundColor: theme.colors.divider }} />
            </View>
        );
    }

    return (
        <SafeAreaProvider initialMetrics={initialWindowMetrics}>
            <AuthProvider initialCredentials={credentials}>
                <ThemeProvider value={navigationTheme}>
                    <ModalProvider>
                        <CommandPaletteProvider>
                            <FaviconPermissionIndicator />
                            <WebReleaseMonitor />
                            <DownloadManager />
                            <React.Suspense fallback={<View style={{ flex: 1, backgroundColor: theme.colors.surface }} />}>
                                <LazySidebarNavigator />
                                <BootstrapHandoff />
                            </React.Suspense>
                        </CommandPaletteProvider>
                    </ModalProvider>
                </ThemeProvider>
            </AuthProvider>
        </SafeAreaProvider>
    );
}
