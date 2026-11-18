import { describe, expect, it } from 'vitest';
import { CodexPreferencesSchema, codexPreferenceMeta } from './codexPreferences';

describe('Codex preferences', () => {
    it('distinguishes CLI defaults, standard speed and the advertised Fast tier', () => {
        expect(codexPreferenceMeta()).toEqual({ verbosity: null, serviceTier: null, collaborationMode: 'default' });
        expect(codexPreferenceMeta(CodexPreferencesSchema.parse({ serviceTier: 'standard' })).serviceTier).toBe('default');
        expect(codexPreferenceMeta(CodexPreferencesSchema.parse({ serviceTier: 'fast', verbosity: 'high', collaborationMode: 'plan' }))).toEqual({ serviceTier: 'fast', verbosity: 'high', collaborationMode: 'plan' });
    });
});
