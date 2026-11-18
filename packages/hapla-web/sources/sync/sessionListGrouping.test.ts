import { describe, expect, it } from 'vitest';
import type { Session } from './storageTypes';
import { buildWorkspaceSessionGroups, mapWorkspaceSessionGroup } from './sessionListGrouping';

function session(input: {
    id: string;
    machineId?: string;
    path?: string;
    active?: boolean;
    presence?: Session['presence'];
    activeAt?: number;
    updatedAt?: number;
    createdAt?: number;
    lastUserMessageAt?: number | null;
    conversationId?: string;
}): Session {
    const active = input.active ?? false;
    const updatedAt = input.updatedAt ?? 0;
    return {
        id: input.id,
        conversationId: input.conversationId,
        seq: 0,
        createdAt: input.createdAt ?? updatedAt,
        updatedAt,
        lastUserMessageAt: input.lastUserMessageAt,
        active,
        activeAt: input.activeAt ?? updatedAt,
        metadata: {
            path: input.path ?? '',
            host: 'test-host',
            machineId: input.machineId,
            flavor: 'codex',
        },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        presence: input.presence ?? (active ? 'online' : updatedAt),
    };
}

function memberIds(groups: ReturnType<typeof buildWorkspaceSessionGroups>): string[][] {
    return groups.map(group => [
        ...group.onlineSessions.map(item => item.id),
        ...group.offlineSessions.map(item => item.id),
    ]);
}

describe('buildWorkspaceSessionGroups', () => {
    it('groups canonical folder paths on the same machine and exposes project identity', () => {
        const groups = buildWorkspaceSessionGroups([
            session({ id: 'first', machineId: 'machine-a', path: '/workspace//hapla/' }),
            session({ id: 'second', machineId: 'machine-a', path: '/workspace/hapla' }),
        ]);

        expect(groups).toHaveLength(1);
        expect(groups[0]).toMatchObject({
            machineId: 'machine-a',
            normalizedPath: '/workspace/hapla',
            displayName: 'hapla',
            hasOnlineSessions: false,
        });
        expect(groups[0].identity.label).toBe('hapla');
        expect(memberIds(groups)).toEqual([['first', 'second']]);
    });

    it('keeps the same path on different machines in different workspace groups', () => {
        const groups = buildWorkspaceSessionGroups([
            session({ id: 'machine-a-session', machineId: 'machine-a', path: '/workspace/hapla' }),
            session({ id: 'machine-b-session', machineId: 'machine-b', path: '/workspace/hapla' }),
        ]);

        expect(groups).toHaveLength(2);
        expect(new Set(groups.map(group => group.machineId))).toEqual(new Set(['machine-a', 'machine-b']));
    });

    it('uses Windows case-insensitive keys while preserving POSIX path case', () => {
        const windows = buildWorkspaceSessionGroups([
            session({ id: 'win-a', machineId: 'windows', path: 'C:\\Work\\Repo\\' }),
            session({ id: 'win-b', machineId: 'windows', path: 'c:/work/repo' }),
        ]);
        const reversedWindows = buildWorkspaceSessionGroups([
            session({ id: 'win-b', machineId: 'windows', path: 'c:/work/repo' }),
            session({ id: 'win-a', machineId: 'windows', path: 'C:\\Work\\Repo\\' }),
        ]);
        const posix = buildWorkspaceSessionGroups([
            session({ id: 'posix-upper', machineId: 'linux', path: '/Work/Repo' }),
            session({ id: 'posix-lower', machineId: 'linux', path: '/work/repo' }),
        ]);

        expect(windows).toHaveLength(1);
        expect(windows[0].normalizedPath).toBe('C:/Work/Repo');
        expect(reversedWindows[0].normalizedPath).toBe(windows[0].normalizedPath);
        expect(posix).toHaveLength(2);
    });

    it('keeps incomplete and relative project locators as singleton groups', () => {
        const groups = buildWorkspaceSessionGroups([
            session({ id: 'missing-path', machineId: 'machine-a' }),
            session({ id: 'missing-machine', path: '/workspace/hapla' }),
            session({ id: 'relative-path', machineId: 'machine-a', path: 'workspace/hapla' }),
        ]);

        expect(groups).toHaveLength(3);
        expect(groups.map(group => group.key).sort()).toEqual([
            'session:missing-machine',
            'session:missing-path',
            'session:relative-path',
        ]);
        expect(groups.every(group => group.displayName.length > 0)).toBe(true);
    });

    it('uses active as the online source of truth even if presence is stale or inconsistent', () => {
        const groups = buildWorkspaceSessionGroups([
            session({
                id: 'active-with-stale-presence', machineId: 'machine-a', path: '/workspace/hapla',
                active: true, presence: 10, activeAt: 30,
            }),
            session({
                id: 'inactive-with-online-presence', machineId: 'machine-a', path: '/workspace/hapla',
                active: false, presence: 'online', updatedAt: 20,
            }),
        ]);

        expect(groups[0].onlineSessions.map(item => item.id)).toEqual(['active-with-stale-presence']);
        expect(groups[0].offlineSessions.map(item => item.id)).toEqual(['inactive-with-online-presence']);
        expect(groups[0].hasOnlineSessions).toBe(true);
    });

    it('sorts folders and both member lists by the last user question regardless of online state', () => {
        const groups = buildWorkspaceSessionGroups([
            session({ id: 'offline-old', machineId: 'offline', path: '/p/offline', lastUserMessageAt: 800 }),
            session({ id: 'offline-new', machineId: 'offline', path: '/p/offline', lastUserMessageAt: 900 }),
            session({ id: 'online-old', machineId: 'online-old', path: '/p/old', active: true, activeAt: 9999, lastUserMessageAt: 100 }),
            session({ id: 'online-newer-2', machineId: 'online-new', path: '/p/new', active: true, activeAt: 9999, updatedAt: 9999, lastUserMessageAt: 200 }),
            session({ id: 'online-newer-1', machineId: 'online-new', path: '/p/new', active: true, activeAt: 200, updatedAt: 20, lastUserMessageAt: 300 }),
        ]);

        expect(groups.map(group => group.machineId)).toEqual(['offline', 'online-new', 'online-old']);
        expect(groups[1].onlineSessions.map(item => item.id)).toEqual(['online-newer-1', 'online-newer-2']);
        expect(groups[0].offlineSessions.map(item => item.id)).toEqual(['offline-new', 'offline-old']);
    });

    it('keeps order unchanged across heartbeat, assistant output, rename, reconnect and shuffled reload responses', () => {
        const original = [
            session({ id: 'a', machineId: 'one', path: '/p/one', active: true, lastUserMessageAt: 10, createdAt: 1 }),
            session({ id: 'b', machineId: 'one', path: '/p/one', active: true, lastUserMessageAt: 20, createdAt: 2 }),
            session({ id: 'c', machineId: 'two', path: '/p/two', lastUserMessageAt: 30, createdAt: 3 }),
        ];
        const reloaded = original.map((item, index) => ({ ...item, updatedAt: 99999 - index, activeAt: 88888 - index, metadata: { ...item.metadata!, name: `Renamed ${index}` } })).reverse();
        expect(memberIds(buildWorkspaceSessionGroups(reloaded))).toEqual(memberIds(buildWorkspaceSessionGroups(original)));
        expect(memberIds(buildWorkspaceSessionGroups(reloaded))).toEqual([['c'], ['b', 'a']]);
    });

    it('moves a folder using a question in its collapsed offline list while keeping all online rows separate', () => {
        const groups = buildWorkspaceSessionGroups([
            session({ id: 'offline-new-question', machineId: 'one', path: '/p/one', lastUserMessageAt: 100 }),
            session({ id: 'online-old-question', machineId: 'one', path: '/p/one', active: true, lastUserMessageAt: 1 }),
            session({ id: 'other-folder', machineId: 'two', path: '/p/two', active: true, lastUserMessageAt: 50 }),
        ]);
        expect(groups[0].machineId).toBe('one');
        expect(groups[0].latestActivityAt).toBe(100);
        expect(groups[0].onlineSessions.map(item => item.id)).toEqual(['online-old-question']);
        expect(groups[0].offlineSessions.map(item => item.id)).toEqual(['offline-new-question']);
    });

    it('does not reorder equal question timestamps using heartbeat or assistant timestamps', () => {
        const groups = buildWorkspaceSessionGroups([
            session({ id: 'b', machineId: 'one', path: '/p/one', active: true, lastUserMessageAt: 100, activeAt: 9999, updatedAt: 9999 }),
            session({ id: 'a', machineId: 'one', path: '/p/one', active: true, lastUserMessageAt: 100, activeAt: 1, updatedAt: 1 }),
        ]);
        expect(groups[0].onlineSessions.map(item => item.id)).toEqual(['a', 'b']);
    });

    it('uses only creation time for an empty conversation without substituting assistant activity', () => {
        const groups = buildWorkspaceSessionGroups([
            session({ id: 'empty', machineId: 'one', path: '/p/one', active: true, createdAt: 9999, updatedAt: 9999, activeAt: 9999 }),
            session({ id: 'question', machineId: 'one', path: '/p/one', active: true, createdAt: 1, lastUserMessageAt: 10 }),
        ]);
        expect(groups[0].onlineSessions.map(item => item.id)).toEqual(['question', 'empty']);
    });

    it('keeps newly created empty folders after folders with a confirmed user question', () => {
        const groups = buildWorkspaceSessionGroups([
            session({ id: 'new-empty', machineId: 'empty-new', path: '/p/empty-new', active: true, createdAt: 9999 }),
            session({ id: 'old-empty', machineId: 'empty-old', path: '/p/empty-old', active: true, createdAt: 500 }),
            session({ id: 'asked', machineId: 'asked', path: '/p/asked', createdAt: 1, lastUserMessageAt: 10 }),
        ]);
        expect(groups.map(group => group.machineId)).toEqual(['asked', 'empty-new', 'empty-old']);
    });

    it('uses the last question across runtime records without promoting a resumed empty runtime', () => {
        const groups = buildWorkspaceSessionGroups([
            session({ id: 'old', conversationId: 'conversation', machineId: 'one', path: '/p/one', createdAt: 1, updatedAt: 10, lastUserMessageAt: 10 }),
            session({ id: 'resumed', conversationId: 'conversation', machineId: 'one', path: '/p/one', active: true, createdAt: 9999, updatedAt: 9999 }),
            session({ id: 'new-question', machineId: 'one', path: '/p/one', active: true, createdAt: 2, lastUserMessageAt: 20 }),
        ]);
        expect(groups[0].onlineSessions.map(item => item.id)).toEqual(['new-question', 'resumed']);
        expect(groups[0].onlineSessions[1].lastUserMessageAt).toBe(10);
    });

    it('uses conversation identity for equal-time ties even when an older runtime receives later output', () => {
        const records = [
            session({ id: 'z-new', conversationId: 'conversation-a', machineId: 'one', path: '/p/one', active: true, createdAt: 20, updatedAt: 50, lastUserMessageAt: 30 }),
            session({ id: 'a-old', conversationId: 'conversation-a', machineId: 'one', path: '/p/one', active: true, createdAt: 1, updatedAt: 10, lastUserMessageAt: 10 }),
            session({ id: 'm-other', conversationId: 'conversation-b', machineId: 'one', path: '/p/one', active: true, createdAt: 2, updatedAt: 5, lastUserMessageAt: 30 }),
        ];
        const before = buildWorkspaceSessionGroups(records)[0].onlineSessions.map(item => item.conversationId);
        records[1].updatedAt = 99999;
        const after = buildWorkspaceSessionGroups(records)[0].onlineSessions.map(item => item.conversationId);
        expect(after).toEqual(before);
        expect(after).toEqual(['conversation-a', 'conversation-b']);
    });

    it('uses keys and ids as deterministic tie breakers without mutating the input', () => {
        const left = session({ id: 'b', machineId: 'same', path: '/p/same', active: true, activeAt: 10, updatedAt: 10 });
        const right = session({ id: 'a', machineId: 'same', path: '/p/same', active: true, activeAt: 10, updatedAt: 10 });
        const other = session({ id: 'c', machineId: 'other', path: '/p/other', active: true, activeAt: 10, updatedAt: 10 });
        const input = [left, right, other];

        const forward = buildWorkspaceSessionGroups(input);
        const reverse = buildWorkspaceSessionGroups([...input].reverse());

        expect(memberIds(forward)).toEqual(memberIds(reverse));
        expect(forward.find(group => group.machineId === 'same')?.onlineSessions.map(item => item.id)).toEqual(['a', 'b']);
        expect(input.map(item => item.id)).toEqual(['b', 'a', 'c']);
    });

    it('collapses repeated runtime records before folder grouping', () => {
        const oldRuntime = session({
            id: 'old-runtime', conversationId: 'conversation', machineId: 'machine-a',
            path: '/workspace/old', updatedAt: 10,
        });
        const newRuntime = session({
            id: 'new-runtime', conversationId: 'conversation', machineId: 'machine-a',
            path: '/workspace/current', active: true, activeAt: 30, updatedAt: 30,
        });

        const groups = buildWorkspaceSessionGroups([oldRuntime, newRuntime]);

        expect(groups).toHaveLength(1);
        expect(groups[0].normalizedPath).toBe('/workspace/current');
        expect(memberIds(groups)).toEqual([['new-runtime']]);
    });

    it('maps row data without changing grouping order or online/offline separation', () => {
        const [group] = buildWorkspaceSessionGroups([
            session({ id: 'online', machineId: 'machine-a', path: '/workspace/hapla', active: true }),
            session({ id: 'offline', machineId: 'machine-a', path: '/workspace/hapla' }),
        ]);

        const mapped = mapWorkspaceSessionGroup(group, item => item.id);

        expect(mapped.onlineSessions).toEqual(['online']);
        expect(mapped.offlineSessions).toEqual(['offline']);
        expect(mapped.key).toBe(group.key);
    });

    it('has no calendar section output', () => {
        const [group] = buildWorkspaceSessionGroups([
            session({ id: 'today', machineId: 'machine-a', path: '/workspace/hapla', updatedAt: Date.now() }),
        ]);

        expect(Object.keys(group).sort()).toEqual([
            'displayName',
            'hasOnlineSessions',
            'identity',
            'key',
            'latestActivityAt',
            'machineId',
            'normalizedPath',
            'offlineSessions',
            'onlineSessions',
        ]);
        expect(JSON.stringify(group)).not.toMatch(/Today|Yesterday|days ago/);
    });
});
