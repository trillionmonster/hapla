import React from 'react';
// @ts-expect-error installed renderer lacks declarations
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    saved: null as null | { token: string; secret: string },
    ensure: vi.fn(), clearMedia: vi.fn(), clearData: vi.fn(), releaseMemory: vi.fn(), syncCreate: vi.fn(), reload: vi.fn(),
    order: [] as string[],
}));
vi.mock('react-native', () => ({ View: 'View', Text: 'Text' }));
vi.mock('@/auth/tokenStorage', () => ({ AUTH_KEY: 'auth_credentials', TokenStorage: {
    getCredentials: async () => mocks.saved,
    setCredentials: async (value: typeof mocks.saved) => { mocks.order.push('save'); mocks.saved = value; return true; },
    removeCredentials: async () => { mocks.order.push('remove'); mocks.saved = null; return true; },
} }));
vi.mock('@/sync/sync', () => ({ syncCreate: mocks.syncCreate }));
vi.mock('./mediaAccess', () => ({ ensureMediaAccess: mocks.ensure, clearMediaAccess: mocks.clearMedia }));
vi.mock('./clearAccountData', () => ({ clearAccountData: mocks.clearData, releaseAccountMemory: mocks.releaseMemory }));
import { AuthProvider, useAuth } from './AuthContext.web';

let auth: ReturnType<typeof useAuth>;
let root: any;
let windowEvents: EventTarget;
const accountA = { token: 'account-a', secret: 'secret-a' };
const accountB = { token: 'account-b', secret: 'secret-b' };
function Harness() { auth = useAuth(); return React.createElement('content', {}, auth.credentials?.token ?? 'signed-out'); }

beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    mocks.saved = accountA;
    mocks.order = [];
    mocks.ensure.mockImplementation(async () => { mocks.order.push('media'); });
    mocks.clearMedia.mockImplementation(async () => { mocks.order.push('clear-media'); });
    mocks.clearData.mockImplementation(async () => { mocks.order.push('clear-data'); });
    mocks.reload.mockImplementation(() => { mocks.order.push('reload'); });
    mocks.syncCreate.mockResolvedValue(undefined);
    windowEvents = new EventTarget();
    vi.stubGlobal('window', Object.assign(windowEvents, { location: { reload: mocks.reload } }));
    vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
});
afterEach(async () => { if (root) await act(async () => root.unmount()); root = null; vi.unstubAllGlobals(); });
const mount = async (credentials: typeof mocks.saved = accountA) => {
    await act(async () => { root = create(React.createElement(AuthProvider, { initialCredentials: credentials, children: React.createElement(Harness) })); });
};

describe('browser account boundaries', () => {
    it('waits for media access and clears account data before switching stored credentials and reloading', async () => {
        await mount();
        await act(async () => auth.login(accountB.token, accountB.secret));
        expect(mocks.order).toEqual(['media', 'clear-data', 'save', 'reload']);
        expect(mocks.saved).toEqual(accountB);
        expect(root.root.findAllByType('content')).toHaveLength(0);
        expect(mocks.syncCreate).not.toHaveBeenCalled();
    });

    it('does not expose a logged-in view before media authentication and synchronization finish', async () => {
        mocks.saved = null;
        let complete!: () => void;
        mocks.ensure.mockImplementation(() => new Promise<void>(resolve => { complete = resolve; }));
        await mount(null);
        let login!: Promise<void>;
        await act(async () => { login = auth.login(accountA.token, accountA.secret); });
        expect(auth.isAuthenticated).toBe(false);
        expect(mocks.syncCreate).not.toHaveBeenCalled();
        await act(async () => { complete(); await login; });
        expect(auth.credentials).toEqual(accountA);
        expect(mocks.syncCreate).toHaveBeenCalledWith(accountA);
    });

    it('clears the account media cookie and caches before removing credentials', async () => {
        await mount();
        await act(async () => auth.logout());
        expect(mocks.order).toEqual(['clear-media', 'clear-data', 'remove', 'reload']);
        expect(mocks.saved).toBeNull();
        expect(root.root.findAllByType('content')).toHaveLength(0);
    });

    it('removes the previous account view when another tab signs into a different account', async () => {
        await mount();
        mocks.saved = accountB;
        await act(async () => {
            windowEvents.dispatchEvent(Object.assign(new Event('storage'), { key: 'auth_credentials' }));
        });
        expect(mocks.releaseMemory).toHaveBeenCalledTimes(1);
        expect(mocks.reload).toHaveBeenCalledTimes(1);
        expect(root.root.findAllByType('content')).toHaveLength(0);
        expect(mocks.ensure).not.toHaveBeenCalled();
    });
});
