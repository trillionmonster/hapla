import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
    connect: vi.fn(), disconnect: vi.fn(), listModels: vi.fn(), listSkills: vi.fn(), setSkillExtraRoots: vi.fn(),
    execFileSync: vi.fn(), resolveExecutable: vi.fn(),
}));
vi.mock('./codexAppServerClient', () => ({ CodexAppServerClient: vi.fn(function () { return mock; }) }));
vi.mock('./utils/resolveCodexExecutable', () => ({ resolveCodexExecutable: mock.resolveExecutable }));
vi.mock('node:child_process', () => ({ execFileSync: mock.execFileSync }));
vi.mock('@/skills/interactiveSkillManifest', () => ({ readInteractiveSkillServer: vi.fn().mockResolvedValue(null) }));
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn() } }));
vi.mock('@/projectPath', () => ({ projectPath: () => '/installation' }));
import { detectCodexVersion, discoverCodexCapabilities, mapCodexModelsToMetadata } from './modelDiscovery';

beforeEach(() => {
    vi.clearAllMocks();
    mock.connect.mockResolvedValue(undefined);
    mock.disconnect.mockResolvedValue(undefined);
    mock.setSkillExtraRoots.mockResolvedValue(undefined);
    mock.listModels.mockResolvedValue([]);
    mock.listSkills.mockResolvedValue([]);
});

describe('mapCodexModelsToMetadata', () => {
    it('uses runnable model names, hides hidden entries, and puts the default first', () => {
        const base = {
            description: '',
            hidden: false,
            defaultReasoningEffort: 'medium',
            supportedReasoningEfforts: [
                { reasoningEffort: 'low', description: 'Fast' },
                { reasoningEffort: 'medium', description: 'Balanced' },
            ],
        };

        expect(mapCodexModelsToMetadata([
            { ...base, id: 'catalog-old', model: 'gpt-old', displayName: 'GPT Old', isDefault: false },
            { ...base, id: 'catalog-default', model: 'gpt-current', displayName: 'GPT Current', description: 'Recommended', isDefault: true },
            { ...base, id: 'catalog-hidden', model: 'gpt-hidden', displayName: 'Hidden', hidden: true, isDefault: false },
        ])).toEqual([
            {
                code: 'gpt-current',
                value: 'GPT Current',
                description: 'Recommended',
                supportedEffortLevels: ['low', 'medium'],
                effortDescriptions: { low: 'Fast', medium: 'Balanced' },
                defaultEffortLevel: 'medium',
            },
            {
                code: 'gpt-old',
                value: 'GPT Old',
                description: null,
                supportedEffortLevels: ['low', 'medium'],
                effortDescriptions: { low: 'Fast', medium: 'Balanced' },
                defaultEffortLevel: 'medium',
            },
        ]);
    });
});

describe('Codex discovery', () => {
    it('detects the actual selected executable with a bounded timeout', () => {
        mock.resolveExecutable.mockReturnValue('/custom/codex');
        mock.execFileSync.mockReturnValue('codex-cli 0.200.0\n');
        expect(detectCodexVersion()).toBe('codex-cli 0.200.0');
        expect(mock.execFileSync).toHaveBeenCalledWith('/custom/codex', ['--version'], expect.objectContaining({ timeout: 5_000 }));
    });

    it('keeps a successful model catalog when skill extension setup is unsupported', async () => {
        mock.listModels.mockResolvedValue([{
            id: 'catalog-model', model: 'new-model', displayName: 'New Model', description: 'New description',
            isDefault: true, hidden: false, defaultReasoningEffort: 'new-effort',
            supportedReasoningEfforts: [{ reasoningEffort: 'new-effort', description: 'Exact CLI explanation' }],
        }]);
        mock.setSkillExtraRoots.mockRejectedValue(new Error('Unsupported skills extension'));
        await expect(discoverCodexCapabilities('/workspace', { strict: true })).resolves.toMatchObject({
            models: [{ code: 'new-model', effortDescriptions: { 'new-effort': 'Exact CLI explanation' } }],
            skills: [], skillsError: 'Unsupported skills extension',
        });
        expect(mock.disconnect).toHaveBeenCalledTimes(1);
    });

    it('surfaces a model refresh failure and disconnects in strict mode', async () => {
        mock.listModels.mockRejectedValue(new Error('model/list unavailable'));
        await expect(discoverCodexCapabilities('/workspace', { strict: true })).rejects.toThrow('model/list unavailable');
        expect(mock.disconnect).toHaveBeenCalledTimes(1);
    });

    it('retains best-effort startup compatibility for failed discovery', async () => {
        mock.connect.mockRejectedValue(new Error('Codex missing'));
        await expect(discoverCodexCapabilities()).resolves.toEqual({ models: [], skills: [] });
        expect(mock.disconnect).toHaveBeenCalledTimes(1);
    });
});
