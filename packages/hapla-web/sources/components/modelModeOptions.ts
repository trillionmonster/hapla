import type { MachineMetadata, Metadata } from '@/sync/storageTypes';
import { hackModes } from '@/sync/modeHacks';

export type ModeOption = {
    key: string;
    name: string;
    description?: string | null;
};

export type PermissionMode = ModeOption;
export type EffortLevel = ModeOption;
export type PermissionModeKey = string;
export type ModelModeKey = string;
export type AgentFlavor = 'claude' | 'codex' | string | null | undefined;

export type ModelMode = ModeOption & {
    supportedServiceTiers?: string[];
    supportedEffortLevels?: string[];
    effortDescriptions?: Record<string, string>;
    defaultEffortLevel?: string | null;
};

type Translate = (key: any) => string;
type MetadataOption = {
    supportedServiceTiers?: string[];
    code: string;
    value: string;
    description?: string | null;
    supportedEffortLevels?: string[];
    effortDescriptions?: Record<string, string>;
    defaultEffortLevel?: string | null;
};

export function mapMetadataOptions(options?: MetadataOption[] | null): ModelMode[] {
    if (!options?.length) {
        return [];
    }

    return options.map((option) => ({
        key: option.code,
        name: option.value,
        description: option.description ?? null,
        supportedEffortLevels: option.supportedEffortLevels ?? [],
        ...(option.effortDescriptions ? { effortDescriptions: option.effortDescriptions } : {}),
        defaultEffortLevel: option.defaultEffortLevel ?? null,
        ...(option.supportedServiceTiers ? { supportedServiceTiers: option.supportedServiceTiers } : {}),
    }));
}

/** Machine discovery follows CLI updates; a session's catalog is a startup snapshot. */
export function resolveModelCatalog(
    flavor: AgentFlavor,
    machine: MachineMetadata | null | undefined,
    session?: Pick<Metadata, 'models'> | null,
): Metadata['models'] {
    if (flavor === 'codex' || flavor === 'claude') {
        const current = machine?.cliCapabilities?.[flavor]?.models;
        if (current !== undefined) return current;
        if (flavor === 'codex' && machine?.codexModels !== undefined) return machine.codexModels;
    }
    return session?.models;
}

export function getClaudePermissionModes(translate: Translate): PermissionMode[] {
    return [
        { key: 'default', name: translate('agentInput.permissionMode.default'), description: null },
        { key: 'plan', name: translate('agentInput.permissionMode.plan'), description: null },
        { key: 'dontAsk', name: translate('agentInput.permissionMode.dontAsk'), description: null },
        { key: 'acceptEdits', name: translate('agentInput.permissionMode.acceptEdits'), description: null },
        { key: 'bypassPermissions', name: translate('agentInput.permissionMode.bypassPermissions'), description: null },
    ];
}

export function getCodexPermissionModes(translate: Translate): PermissionMode[] {
    return [
        { key: 'default', name: translate('agentInput.codexPermissionMode.default'), description: null },
        { key: 'read-only', name: translate('agentInput.codexPermissionMode.readOnly'), description: null },
        { key: 'safe-yolo', name: translate('agentInput.codexPermissionMode.safeYolo'), description: null },
        { key: 'yolo', name: translate('agentInput.codexPermissionMode.yolo'), description: null },
    ];
}

export function getHardcodedPermissionModes(flavor: AgentFlavor, translate: Translate): PermissionMode[] {
    return flavor === 'codex'
        ? getCodexPermissionModes(translate)
        : getClaudePermissionModes(translate);
}

/**
 * Fallbacks deliberately contain no named model or effort guesses. When a CLI
 * catalog is unavailable, Hapla lets that CLI resolve its own default.
 */
export function getHardcodedModelModes(_flavor: AgentFlavor, _translate: Translate): ModelMode[] {
    return [{
        key: 'default',
        name: 'CLI default',
        description: 'Resolved by the installed CLI',
        supportedEffortLevels: [],
        defaultEffortLevel: null,
    }];
}

export function getAvailableModels(
    flavor: AgentFlavor,
    metadata: Pick<Metadata, 'models'> | null | undefined,
    translate: Translate,
): ModelMode[] {
    const discovered = mapMetadataOptions(metadata?.models);
    const cliDefault = getHardcodedModelModes(flavor, translate)[0];
    if (discovered.length === 0) {
        return [cliDefault];
    }
    // Discovery places the CLI's advertised default first. Expose its controls
    // even before a new thread has a concrete model name.
    cliDefault.supportedEffortLevels = discovered[0].supportedEffortLevels;
    cliDefault.effortDescriptions = discovered[0].effortDescriptions;
    cliDefault.defaultEffortLevel = discovered[0].defaultEffortLevel;
    cliDefault.supportedServiceTiers = discovered[0].supportedServiceTiers;
    // `default` is a deliberate compatibility option, not an invented model.
    // It lets official and self-hosted CLIs resolve their own configured model
    // while every named entry below still comes from live CLI discovery.
    return discovered.some((model) => model.key === 'default')
        ? discovered
        : [cliDefault, ...discovered];
}

export function getAvailablePermissionModes(
    flavor: AgentFlavor,
    _metadata: Metadata | null | undefined,
    translate: Translate,
): PermissionMode[] {
    return hackModes(getHardcodedPermissionModes(flavor, translate));
}

export function findOptionByKey<T extends ModeOption>(options: T[], key: string | null | undefined): T | null {
    if (!key) {
        return null;
    }
    return options.find((option) => option.key === key) ?? null;
}

export function resolveCurrentOption<T extends ModeOption>(
    options: T[],
    preferredKeys: Array<string | null | undefined>,
): T | null {
    for (const key of preferredKeys) {
        const option = findOptionByKey(options, key);
        if (option) {
            return option;
        }
    }
    return options[0] ?? null;
}

export function getDefaultModelKey(_flavor: AgentFlavor): string {
    return 'default';
}

export function getDefaultPermissionModeKey(flavor: AgentFlavor): string {
    return flavor === 'codex' ? 'yolo' : 'default';
}

export function getEffortLevelsForModel(
    _flavor: AgentFlavor,
    modelKey: string,
    models: ModelMode[] = [],
): EffortLevel[] {
    const model = models.find((candidate) => candidate.key === modelKey);
    return [
        { key: 'default', name: 'CLI default', description: 'Resolved by the installed CLI' },
        ...(model?.supportedEffortLevels ?? [])
            .filter((key) => key !== 'default')
            .map((key) => ({
                key,
                name: key,
                ...(model?.effortDescriptions?.[key] ? { description: model.effortDescriptions[key] } : {}),
            })),
    ];
}

export function getDefaultEffortKeyForModel(
    _flavor: AgentFlavor,
    modelKey: string,
    models: ModelMode[] = [],
): string | null {
    const model = models.find((candidate) => candidate.key === modelKey);
    if (!model) {
        return null;
    }
    if (model.defaultEffortLevel && model.supportedEffortLevels?.includes(model.defaultEffortLevel)) {
        return model.defaultEffortLevel;
    }
    return model.supportedEffortLevels?.[0] ?? null;
}

export function getSupportsWorktree(_flavor: AgentFlavor): boolean {
    return true;
}
