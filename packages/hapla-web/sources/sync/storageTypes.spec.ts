import { describe, expect, it } from 'vitest';
import { MachineMetadataSchema, MetadataSchema } from './storageTypes';

describe('MetadataSchema', () => {
    it('preserves archive lifecycle metadata', () => {
        const metadata = MetadataSchema.parse({
            path: '/tmp/project',
            host: 'local-machine',
            startedBy: 'daemon',
            startedFromDaemon: true,
            lifecycleState: 'archived',
            lifecycleStateSince: 123,
            archivedBy: 'cli',
            archiveReason: 'User terminated',
        });

        expect(metadata.startedBy).toBe('daemon');
        expect(metadata.startedFromDaemon).toBe(true);
        expect(metadata.lifecycleState).toBe('archived');
        expect(metadata.lifecycleStateSince).toBe(123);
        expect(metadata.archivedBy).toBe('cli');
        expect(metadata.archiveReason).toBe('User terminated');
    });

    it('accepts legacy metadata without path and host', () => {
        const metadata = MetadataSchema.parse({
            name: 'Legacy Session',
            summary: {
                text: 'Recovered legacy session',
                updatedAt: 123,
            },
            machineId: 'legacy-machine',
        });

        expect(metadata.name).toBe('Legacy Session');
        expect(metadata.summary?.text).toBe('Recovered legacy session');
        expect(metadata.machineId).toBe('legacy-machine');
        expect(metadata.path).toBe('');
        expect(metadata.host).toBe('');
    });

    it('preserves the Codex model catalog published by the selected machine', () => {
        const metadata = MachineMetadataSchema.parse({
            host: 'local-machine',
            platform: 'linux',
            happyCliVersion: '1.1.6',
            happyHomeDir: '/home/test/.hapla',
            homeDir: '/home/test',
            codexVersion: 'codex-cli 0.144.1',
            codexModels: [{
                code: 'gpt-current',
                value: 'GPT Current',
                description: 'Default catalog model',
            }],
        });

        expect(metadata.codexModels).toEqual([{
            code: 'gpt-current',
            value: 'GPT Current',
            description: 'Default catalog model',
            supportedEffortLevels: [],
        }]);
    });

    it('preserves per-effort descriptions through machine and session metadata parsing', () => {
        const models = [{
            code: 'current', value: 'Current', supportedEffortLevels: ['ultra'],
            effortDescriptions: { ultra: 'The current CLI explanation' }, defaultEffortLevel: 'ultra',
        }];
        const machine = MachineMetadataSchema.parse({
            host: 'test', platform: 'linux', happyCliVersion: '1', happyHomeDir: '/home/test/.hapla', homeDir: '/home/test',
            codexModels: models,
            cliCapabilities: { codex: { version: 'codex-cli 0.200.0', models, skills: [] }, discoveredAt: 1 },
        });
        expect(machine.codexModels?.[0].effortDescriptions).toEqual(models[0].effortDescriptions);
        expect(machine.cliCapabilities?.codex?.models[0].effortDescriptions).toEqual(models[0].effortDescriptions);
        expect(MetadataSchema.parse({ models }).models?.[0].effortDescriptions).toEqual(models[0].effortDescriptions);
    });
});
