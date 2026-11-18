import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, AppStateStatus, Platform } from 'react-native';
import * as Updates from 'expo-updates';
import {
    fetchPublishedWebRelease,
    loadedWebRelease,
    onWebReleaseCheckRequested,
    removeWebRefreshMarker,
    webRefreshUrl,
    webReleaseChanged,
    type WebReleaseCheckReason,
} from '@/utils/webRelease';

type PendingOtaUpdate = {
    ota_version?: string;
    ota_runtime_version?: string;
    web_release?: string;
};

type WebReleaseDiagnostics = {
    checkedAt: string;
    error: string | null;
    loaded: string | null;
    published: string | null;
    reason: WebReleaseCheckReason;
    stale: boolean;
};

declare global {
    interface Window {
        __HAPLA_WEB_RELEASE__?: WebReleaseDiagnostics;
    }
}

const WEB_RELEASE_POLL_MS = 30_000;
const WEB_RELEASE_TIMEOUT_MS = 8_000;

export function useUpdates() {
    const [updateAvailable, setUpdateAvailable] = useState(false);
    const [isChecking, setIsChecking] = useState(false);
    const [pendingUpdate, setPendingUpdate] = useState<PendingOtaUpdate | null>(null);
    const isCheckingRef = useRef(false);
    const loadedReleaseRef = useRef<string | null>(null);
    const publishedReleaseRef = useRef<string | null>(null);
    const lastLoggedReleaseRef = useRef<string | null>(null);

    const recordWebRelease = useCallback((
        reason: WebReleaseCheckReason,
        published: string | null,
        error: unknown = null,
    ) => {
        const loaded = loadedReleaseRef.current;
        const stale = webReleaseChanged(loaded, published);
        const errorMessage = error instanceof Error ? error.message : error ? String(error) : null;
        const diagnostics: WebReleaseDiagnostics = {
            checkedAt: new Date().toISOString(),
            error: errorMessage,
            loaded,
            published,
            reason,
            stale,
        };
        window.__HAPLA_WEB_RELEASE__ = diagnostics;
        document.documentElement.dataset.haplaWebRelease = loaded ?? 'unknown';
        document.documentElement.dataset.haplaPublishedRelease = published ?? 'unknown';
        document.documentElement.dataset.haplaWebReleaseStale = String(stale);

        // Keep routine 30-second checks quiet. Log the first comparison and
        // every state transition so production diagnostics identify both the
        // running bundle and the currently published bundle.
        const signature = `${loaded ?? 'unknown'}|${published ?? 'unknown'}|${stale}|${errorMessage ?? ''}`;
        if (signature !== lastLoggedReleaseRef.current) {
            lastLoggedReleaseRef.current = signature;
            const message = `[Hapla Web release] loaded=${loaded ?? 'unknown'} published=${published ?? 'unknown'} stale=${stale} reason=${reason}${errorMessage ? ` error=${errorMessage}` : ''}`;
            if (errorMessage || stale) console.warn(message);
            else console.info(message);
        }
    }, []);

    const checkForUpdates = useCallback(async (reason: WebReleaseCheckReason = 'manual') => {
        if (__DEV__) {
            // Don't check for updates in development
            return;
        }

        if (isCheckingRef.current) return;

        isCheckingRef.current = true;
        setIsChecking(true);

        try {
            if (Platform.OS === 'web') {
                const controller = new AbortController();
                const timeout = window.setTimeout(() => controller.abort(), WEB_RELEASE_TIMEOUT_MS);
                try {
                    const publishedRelease = await fetchPublishedWebRelease(
                        window.fetch.bind(window),
                        new URL('/index.html', window.location.href).toString(),
                        controller.signal,
                    );
                    publishedReleaseRef.current = publishedRelease;
                    const changed = webReleaseChanged(loadedReleaseRef.current, publishedRelease);
                    if (loadedReleaseRef.current !== null && publishedRelease !== null) {
                        if (changed) {
                            setPendingUpdate({ web_release: publishedRelease });
                        } else {
                            setPendingUpdate(null);
                        }
                        setUpdateAvailable(changed);
                    }
                    recordWebRelease(reason, publishedRelease);
                } finally {
                    window.clearTimeout(timeout);
                }
                return;
            }

            const update = await Updates.checkForUpdateAsync();
            if (update.isAvailable) {
                const nextPendingUpdate = {
                    ota_version: update.manifest.id,
                    ota_runtime_version: 'runtimeVersion' in update.manifest ? update.manifest.runtimeVersion : undefined,
                };
                await Updates.fetchUpdateAsync();
                setPendingUpdate(nextPendingUpdate);
                setUpdateAvailable(true);
            }
        } catch (error) {
            if (Platform.OS === 'web') recordWebRelease(reason, publishedReleaseRef.current, error);
            else console.error('Error checking for updates:', error);
        } finally {
            isCheckingRef.current = false;
            setIsChecking(false);
        }
    }, [recordWebRelease]);

    useEffect(() => {
        if (Platform.OS === 'web') {
            loadedReleaseRef.current = loadedWebRelease([
                ...Array.from(document.scripts, (script) => script.src),
                ...Array.from(document.querySelectorAll<HTMLLinkElement>('link[href]'), (link) => link.href),
            ]);
            recordWebRelease('initial', null);
            const cleanUrl = removeWebRefreshMarker(window.location.href);
            if (cleanUrl) window.history.replaceState(window.history.state, '', cleanUrl);

            const checkWhenVisible = () => {
                if (document.visibilityState === 'visible') void checkForUpdates('visible');
            };
            const checkWhenFocused = () => void checkForUpdates('focus');
            const checkWhenOnline = () => void checkForUpdates('online');
            const unsubscribeRequestedCheck = onWebReleaseCheckRequested((reason) => void checkForUpdates(reason));
            const timer = window.setInterval(() => void checkForUpdates('interval'), WEB_RELEASE_POLL_MS);
            document.addEventListener('visibilitychange', checkWhenVisible);
            window.addEventListener('focus', checkWhenFocused);
            window.addEventListener('online', checkWhenOnline);
            void checkForUpdates('initial');
            return () => {
                window.clearInterval(timer);
                document.removeEventListener('visibilitychange', checkWhenVisible);
                window.removeEventListener('focus', checkWhenFocused);
                window.removeEventListener('online', checkWhenOnline);
                unsubscribeRequestedCheck();
            };
        }

        const handleAppStateChange = (nextAppState: AppStateStatus) => {
            if (nextAppState === 'active') void checkForUpdates('visible');
        };
        const subscription = AppState.addEventListener('change', handleAppStateChange);
        void checkForUpdates('initial');
        return () => subscription.remove();
    }, [checkForUpdates]);

    const reloadApp = useCallback(async () => {
        if (Platform.OS === 'web') {
            window.location.replace(webRefreshUrl(window.location.href, pendingUpdate?.web_release ?? null));
        } else {
            try {
                await Updates.reloadAsync();
            } catch (error) {
                console.error('Error reloading app:', error);
            }
        }
    }, [pendingUpdate?.web_release]);

    return {
        updateAvailable,
        isChecking,
        checkForUpdates,
        reloadApp,
    };
}
