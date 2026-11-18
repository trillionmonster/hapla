import { describe, expect, it } from 'vitest';
import { resolvePreferredMachineId } from '@/utils/machineSelection';
import type { Machine } from '@/sync/storageTypes';

function makeMachine(id: string, active: boolean): Machine {
    return {
        id,
        seq: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        active,
        activeAt: Date.now(),
        metadata: null,
        metadataVersion: 1,
        daemonState: null,
        daemonStateVersion: 1,
    };
}

describe('resolvePreferredMachineId', () => {
    it('keeps the current machine when it still exists', () => {
        const machines = [
            makeMachine('offline-a', false),
            makeMachine('online-b', true),
        ];

        expect(resolvePreferredMachineId(machines, 'online-b')).toBe('online-b');
    });

    it('falls back to the first online machine when the draft points to a stale id', () => {
        const machines = [
            makeMachine('offline-a', false),
            makeMachine('online-b', true),
            makeMachine('online-c', true),
        ];

        expect(resolvePreferredMachineId(machines, 'missing-id')).toBe('online-b');
    });

    it('falls back to an online machine when the remembered machine is offline', () => {
        const machines = [
            makeMachine('offline-a', false),
            makeMachine('online-b', true),
        ];

        expect(resolvePreferredMachineId(machines, 'offline-a')).toBe('online-b');
    });

    it('falls back to the first machine when none are online', () => {
        const machines = [
            makeMachine('offline-a', false),
            makeMachine('offline-b', false),
        ];

        expect(resolvePreferredMachineId(machines, null)).toBe('offline-a');
    });
});
