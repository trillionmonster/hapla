import { describe, expect, it } from 'vitest';
import {
    getAvailableModels,
    getAvailablePermissionModes,
    getClaudePermissionModes,
    getDefaultEffortKeyForModel,
    getDefaultModelKey,
    getDefaultPermissionModeKey,
    getEffortLevelsForModel,
    mapMetadataOptions,
    resolveCurrentOption,
    resolveModelCatalog,
} from './modelModeOptions';

const translate = (key: string) => `tr:${key}`;

describe('modelModeOptions', () => {
    it('maps the CLI model catalog including its effort capabilities', () => {
        expect(mapMetadataOptions([
            {
                code: 'm1',
                value: 'Model One',
                description: 'Primary model',
                supportedEffortLevels: ['low', 'high'],
                effortDescriptions: { low: 'Fast response', high: 'Deeper reasoning' },
                defaultEffortLevel: 'high',
            },
        ])).toEqual([{
            key: 'm1',
            name: 'Model One',
            description: 'Primary model',
            supportedEffortLevels: ['low', 'high'],
            effortDescriptions: { low: 'Fast response', high: 'Deeper reasoning' },
            defaultEffortLevel: 'high',
        }]);
    });

    it('builds Claude permission modes with translated names', () => {
        const modes = getClaudePermissionModes(translate);
        expect(modes.map((mode) => mode.key)).toEqual([
            'default',
            'plan',
            'dontAsk',
            'acceptEdits',
            'bypassPermissions',
        ]);
    });

    it('uses only model names advertised by the active CLI', () => {
        const models = getAvailableModels('codex', {
            models: [{
                code: 'future-model',
                value: 'Future Model',
                description: 'From /model',
                supportedEffortLevels: ['minimal', 'high'],
                defaultEffortLevel: 'minimal',
            }],
        } as any, translate);

        expect(models.map((model) => model.key)).toEqual(['default', 'future-model']);
        expect(getEffortLevelsForModel('codex', 'future-model', models).map((effort) => effort.key))
            .toEqual(['default', 'minimal', 'high']);
        expect(getDefaultEffortKeyForModel('codex', 'future-model', models)).toBe('minimal');
    });

    it('falls back to the CLI default without inventing model or effort names', () => {
        const models = getAvailableModels('claude', null, translate);
        expect(models).toEqual([{
            key: 'default',
            name: 'CLI default',
            description: 'Resolved by the installed CLI',
            supportedEffortLevels: [],
            defaultEffortLevel: null,
        }]);
        expect(getEffortLevelsForModel('claude', 'default', models)).toEqual([{
            key: 'default',
            name: 'CLI default',
            description: 'Resolved by the installed CLI',
        }]);
        expect(getDefaultEffortKeyForModel('claude', 'default', models)).toBeNull();
    });

    it('does not duplicate a default model advertised by a self-hosted CLI', () => {
        const models = getAvailableModels('codex', {
            models: [
                { code: 'default', value: 'Private gateway default' },
                { code: 'private-model', value: 'Private Model' },
            ],
        } as any, translate);

        expect(models.map((model) => model.key)).toEqual(['default', 'private-model']);
        expect(models[0].name).toBe('Private gateway default');
    });

    it('keeps provider permission policies independent from model discovery', () => {
        expect(getAvailablePermissionModes('codex', null, translate).map((mode) => mode.key))
            .toEqual(['default', 'read-only', 'safe-yolo', 'yolo']);
        expect(getDefaultModelKey('codex')).toBe('default');
        expect(getDefaultPermissionModeKey('codex')).toBe('yolo');
    });

    it('resolves a preferred option and otherwise uses the first available option', () => {
        const options = [
            { key: 'a', name: 'A' },
            { key: 'b', name: 'B' },
        ];
        expect(resolveCurrentOption(options, ['missing', 'b'])).toEqual({ key: 'b', name: 'B' });
        expect(resolveCurrentOption(options, ['missing'])).toEqual({ key: 'a', name: 'A' });
    });

    it('shows newly advertised reasoning levels and their exact descriptions', () => {
        const models = mapMetadataOptions([{
            code: 'new-model', value: 'New model', supportedEffortLevels: ['ultra', 'experimental'],
            effortDescriptions: { ultra: 'More time for complex tasks', experimental: 'Provider-specific new effort' },
        }]);
        expect(getEffortLevelsForModel('codex', 'new-model', models)).toEqual([
            { key: 'default', name: 'CLI default', description: 'Resolved by the installed CLI' },
            { key: 'ultra', name: 'ultra', description: 'More time for complex tasks' },
            { key: 'experimental', name: 'experimental', description: 'Provider-specific new effort' },
        ]);
    });

    it('uses the refreshed machine catalog instead of a session startup snapshot', () => {
        const latest = [{ code: 'current', value: 'Current', supportedEffortLevels: ['high'] }];
        const legacy = [{ code: 'legacy', value: 'Legacy' }];
        const stale = { models: [{ code: 'retired', value: 'Retired' }] };
        expect(resolveModelCatalog('codex', {
            cliCapabilities: { codex: { models: latest } }, codexModels: legacy,
        } as any, stale)).toEqual(latest);
        expect(resolveModelCatalog('codex', { codexModels: legacy } as any, stale)).toEqual(legacy);
        expect(resolveModelCatalog('codex', undefined, stale)).toEqual(stale.models);
        expect(resolveModelCatalog('codex', {
            cliCapabilities: { codex: { models: [] } }, codexModels: legacy,
        } as any, stale)).toEqual(legacy);
    });
});
