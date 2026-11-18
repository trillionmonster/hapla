import { MMKV } from 'react-native-mmkv';
import { selectServerUrl } from './serverUrlSelection';

// Separate MMKV instance for server config that persists across logouts
const serverConfigStorage = new MMKV({ id: 'server-config' });

const SERVER_KEY = 'custom-server-url';
const LOG_SERVER_KEY = 'log-server-url';

function getSelfHostedUrl(): string | undefined {
    if (typeof window !== 'undefined' && window.location) {
        const origin = window.location.origin;
        // If served from a self-hosted deployment (not the default cloud app),
        // use the same origin as the API server (nginx reverse proxy)
        if (origin) {
            return origin;
        }
    }
    return undefined;
}

export function getServerUrl(): string {
    return selectServerUrl({
        stored: serverConfigStorage.getString(SERVER_KEY),
        configured: process.env.EXPO_PUBLIC_HAPLA_SERVER_URL,
        browserOrigin: getSelfHostedUrl(),
    });
}

export function setServerUrl(url: string | null): void {
    if (url && url.trim()) {
        serverConfigStorage.set(SERVER_KEY, url.trim());
    } else {
        serverConfigStorage.delete(SERVER_KEY);
    }
}

// Log server URL permanently disabled — no remote logging
export function getLogServerUrl(): string | null {
    return null;
}

export function setLogServerUrl(_url: string | null): void {
    // noop — remote logging disabled
}

export function isUsingCustomServer(): boolean {
    return getServerUrl() !== 'http://127.0.0.1:3005';
}

export function getServerInfo(): { hostname: string; port?: number; isCustom: boolean } {
    const url = getServerUrl();
    const isCustom = isUsingCustomServer();
    
    try {
        const parsed = new URL(url);
        const port = parsed.port ? parseInt(parsed.port) : undefined;
        return {
            hostname: parsed.hostname,
            port,
            isCustom
        };
    } catch {
        // Fallback if URL parsing fails
        return {
            hostname: url,
            port: undefined,
            isCustom
        };
    }
}

export function validateServerUrl(url: string): { valid: boolean; error?: string } {
    if (!url || !url.trim()) {
        return { valid: false, error: 'Server URL cannot be empty' };
    }
    
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return { valid: false, error: 'Server URL must use HTTP or HTTPS protocol' };
        }
        return { valid: true };
    } catch {
        return { valid: false, error: 'Invalid URL format' };
    }
}
