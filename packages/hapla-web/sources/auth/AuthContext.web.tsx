import * as React from 'react';
import { AUTH_KEY, TokenStorage, type AuthCredentials } from '@/auth/tokenStorage';
import { syncCreate } from '@/sync/sync';
import { clearMediaAccess, ensureMediaAccess } from './mediaAccess';
import { clearAccountData, releaseAccountMemory } from './clearAccountData';
import { View, Text } from 'react-native';

interface AuthContextType {
    isAuthenticated: boolean;
    credentials: AuthCredentials | null;
    login: (token: string, secret: string) => Promise<void>;
    logout: () => Promise<void>;
}

const AuthContext = React.createContext<AuthContextType | undefined>(undefined);
let currentAuthState: AuthContextType | null = null;

export function AuthProvider(props: { children: React.ReactNode; initialCredentials: AuthCredentials | null }) {
    const [credentials, setCredentials] = React.useState<AuthCredentials | null>(props.initialCredentials);
    const [transitioning, setTransitioning] = React.useState(false);
    const transitionRef = React.useRef(false);
    const isAuthenticated = credentials !== null;

    const login = React.useCallback(async (token: string, secret: string) => {
        const nextCredentials = { token, secret };
        const changed = credentials && (credentials.token !== token || credentials.secret !== secret);
        await ensureMediaAccess(nextCredentials);
        if (changed) {
            transitionRef.current = true;
            setTransitioning(true);
            try { await clearAccountData(); }
            catch (error) { window.location.reload(); throw error; }
        }
        if (!await TokenStorage.setCredentials(nextCredentials)) {
            if (changed) window.location.reload();
            throw new Error('Failed to save credentials');
        }
        if (changed) {
            window.location.reload();
            return;
        }
        await syncCreate(nextCredentials);
        setCredentials(nextCredentials);
    }, [credentials]);

    const logout = React.useCallback(async () => {
        if (credentials) await clearMediaAccess(credentials);
        transitionRef.current = true;
        setTransitioning(true);
        try { await clearAccountData(); }
        catch (error) { window.location.reload(); throw error; }
        await TokenStorage.removeCredentials();
        setCredentials(null);
        window.location.reload();
    }, [credentials]);

    React.useEffect(() => {
        // Cookies and credentials belong to one browser profile. A second tab
        // must not keep rendering the previous account after an account switch.
        const reconcile = async () => {
            if (transitionRef.current) return;
            const saved = await TokenStorage.getCredentials();
            if (transitionRef.current) return;
            if (saved?.token !== credentials?.token || saved?.secret !== credentials?.secret) {
                transitionRef.current = true;
                setTransitioning(true);
                releaseAccountMemory();
                window.location.reload();
                return;
            }
            if (saved) await ensureMediaAccess(saved);
        };
        const check = () => { void reconcile().catch(() => undefined); };
        const onStorage = (event: StorageEvent) => { if (event.key === AUTH_KEY || event.key === null) check(); };
        const onVisible = () => { if (document.visibilityState === 'visible') check(); };
        window.addEventListener('storage', onStorage);
        window.addEventListener('pageshow', check);
        document.addEventListener('visibilitychange', onVisible);
        const timer = setInterval(check, 60 * 60 * 1000);
        return () => {
            window.removeEventListener('storage', onStorage);
            window.removeEventListener('pageshow', check);
            document.removeEventListener('visibilitychange', onVisible);
            clearInterval(timer);
        };
    }, [credentials]);

    const value = React.useMemo<AuthContextType>(() => ({
        isAuthenticated,
        credentials,
        login,
        logout,
    }), [credentials, isAuthenticated, login, logout]);

    React.useEffect(() => {
        currentAuthState = value;
        return () => {
            if (currentAuthState === value) currentAuthState = null;
        };
    }, [value]);

    return <AuthContext.Provider value={value}>{transitioning
        ? <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><Text>正在切换账号…</Text></View>
        : props.children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextType {
    const context = React.useContext(AuthContext);
    if (!context) throw new Error('useAuth must be used within an AuthProvider');
    return context;
}

export function setCurrentAuth(auth: AuthContextType | null): void {
    currentAuthState = auth;
}

export function getCurrentAuth(): AuthContextType | null {
    return currentAuthState;
}
