import { describe, expect, it } from 'vitest';
import { mapClaudeCommandsToSkills, mapClaudeModelsToMetadata } from './capabilityDiscovery';

describe('Claude capability discovery mapping', () => {
    it('keeps the effort levels advertised by the Claude CLI', () => {
        expect(mapClaudeModelsToMetadata([{
            value: 'opus',
            displayName: 'Opus',
            description: 'Most capable',
            supportsEffort: true,
            supportedEffortLevels: ['low', 'medium', 'high', 'max'],
        }])).toEqual([{
            code: 'opus',
            value: 'Opus',
            description: 'Most capable',
            supportedEffortLevels: ['low', 'medium', 'high', 'max'],
            defaultEffortLevel: null,
        }]);
    });

    it('maps slash commands into skill metadata', () => {
        expect(mapClaudeCommandsToSkills([{
            name: 'review',
            description: 'Review a pull request',
            argumentHint: '<pr>',
        }])).toEqual([{
            name: 'review',
            description: 'Review a pull request',
            path: null,
            enabled: true,
            scope: 'claude',
            argumentHint: '<pr>',
        }]);
    });
});
