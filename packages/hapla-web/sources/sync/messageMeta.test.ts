import { describe, expect, it } from 'vitest';
import { resolveMessageModeMeta, resolveMessageCodexPreferenceMeta } from './messageMeta';
import { CodexPreferencesSchema } from './codexPreferences';

describe('resolveMessageModeMeta', () => {
    it('sends explicit permission and model keys', () => {
        const meta = resolveMessageModeMeta({
            permissionMode: 'read-only',
            modelMode: 'gpt-5-high',
            metadata: null,
        } as any);

        expect(meta).toEqual({
            permissionMode: 'read-only',
            model: 'gpt-5-high',
            effort: null,
        });
    });

    it('forces bypass permissions in sandbox when mode is default', () => {
        const meta = resolveMessageModeMeta({
            permissionMode: 'default',
            modelMode: null,
            metadata: {
                sandbox: { enabled: true },
            },
        } as any);

        expect(meta).toEqual({
            permissionMode: 'bypassPermissions',
            model: null,
            effort: null,
        });
    });

    it('keeps default permissions when sandbox is disabled', () => {
        const meta = resolveMessageModeMeta({
            permissionMode: null,
            modelMode: 'default',
            metadata: {
                sandbox: null,
            },
        } as any);

        expect(meta).toEqual({
            permissionMode: 'default',
            model: null,
            effort: null,
        });
    });

    it('does not send a model that disappeared from the latest Codex catalog', () => {
        const meta = resolveMessageModeMeta({
            permissionMode: 'yolo',
            modelMode: 'gpt-retired',
            metadata: {
                models: [{ code: 'gpt-current', value: 'GPT Current' }],
            },
        } as any);

        expect(meta).toEqual({
            permissionMode: 'yolo',
            model: null,
            effort: null,
        });
    });

    it('sends only effort values advertised for the selected model', () => {
        const base = {
            permissionMode: 'default',
            modelMode: 'gpt-current',
            metadata: {
                models: [{
                    code: 'gpt-current',
                    value: 'GPT Current',
                    supportedEffortLevels: ['low', 'high'],
                }],
            },
        } as any;

        expect(resolveMessageModeMeta({ ...base, effortLevel: 'high' }).effort).toBe('high');
        expect(resolveMessageModeMeta({ ...base, effortLevel: 'max' }).effort).toBeNull();
    });

    it('validates newly selected models and effort against refreshed machine metadata', () => {
        const session = {
            permissionMode: 'yolo', modelMode: 'new-model', effortLevel: 'ultra',
            metadata: { flavor: 'codex', models: [{ code: 'retired', value: 'Retired' }] },
        } as any;
        const machine = {
            cliCapabilities: { codex: { models: [{
                code: 'new-model', value: 'New', supportedEffortLevels: ['ultra'],
            }] } },
        } as any;
        expect(resolveMessageModeMeta(session, machine)).toEqual({ permissionMode: 'yolo', model: 'new-model', effort: 'ultra' });
        expect(resolveMessageModeMeta({ ...session, modelMode: 'retired' }, machine).model).toBeNull();
        expect(resolveMessageModeMeta(session, {
            cliCapabilities: { codex: { models: [] } },
        } as any).model).toBeNull();
    });

    it('maps a default Fast preference to the selected model tier even without opening reply settings', () => {
        const session = {
            modelMode: 'default',
            codexPreferences: CodexPreferencesSchema.parse({ serviceTier: 'fast' }),
            metadata: {
                flavor: 'codex', currentModelCode: 'quick-model',
                models: [
                    { code: 'quick-model', value: 'Quick', supportedServiceTiers: ['priority'] },
                    { code: 'standard-model', value: 'Standard', supportedServiceTiers: [] },
                    { code: 'fast-model', value: 'Fast', supportedServiceTiers: ['fast'] },
                ],
            },
        } as any;
        expect(resolveMessageCodexPreferenceMeta(session).serviceTier).toBe('priority');
        expect(resolveMessageCodexPreferenceMeta({ ...session, modelMode: 'standard-model' }).serviceTier).toBeNull();
        expect(resolveMessageCodexPreferenceMeta({ ...session, modelMode: 'fast-model' }).serviceTier).toBe('fast');
        expect(session.codexPreferences.serviceTier).toBe('fast');
    });

    it('checks Fast against the latest machine catalog and preserves an explicit standard override', () => {
        const session = {
            modelMode: 'default',
            codexPreferences: CodexPreferencesSchema.parse({ serviceTier: 'fast' }),
            metadata: { flavor: 'codex', models: [{ code: 'quick', value: 'Quick', supportedServiceTiers: ['priority'] }] },
        } as any;
        const machine = { cliCapabilities: { codex: { models: [{ code: 'quick', value: 'Quick', supportedServiceTiers: [] }] } } } as any;
        expect(resolveMessageCodexPreferenceMeta(session, machine).serviceTier).toBeNull();
        expect(resolveMessageCodexPreferenceMeta({ ...session, metadata: null }).serviceTier).toBeNull();
        expect(resolveMessageCodexPreferenceMeta({
            ...session, codexPreferences: CodexPreferencesSchema.parse({ serviceTier: 'standard' }),
        }, machine).serviceTier).toBe('default');
    });
});
