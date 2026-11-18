import type { MachineMetadata, Session } from './storageTypes';
import type { PermissionModeKey } from '@/components/PermissionModeSelector';
import { resolveModelCatalog } from '@/components/modelModeOptions';
import { codexPreferenceMeta } from './codexPreferences';

function isSandboxEnabled(metadata: Session['metadata'] | null | undefined): boolean {
    const sandbox = metadata?.sandbox;
    return !!sandbox && typeof sandbox === 'object' && (sandbox as { enabled?: unknown }).enabled === true;
}

function resolveMessageModel(
    session: Pick<Session, 'modelMode' | 'metadata'>,
    machineMetadata?: MachineMetadata | null,
) {
    const requestedModel = session.modelMode || 'default';
    const advertisedModels = resolveModelCatalog(session.metadata?.flavor, machineMetadata, session.metadata);
    const isStillAvailable = advertisedModels === undefined
        || requestedModel === 'default'
        || advertisedModels.some((model) => model.code === requestedModel);
    // A model catalog can change when Codex updates. Never resend a stale
    // locally cached model name; omitting it preserves the thread's resolved
    // model instead.
    const model = requestedModel !== 'default' && isStillAvailable ? requestedModel : null;
    const resolvedModel = advertisedModels?.find((candidate) => candidate.code === (model ?? session.metadata?.currentModelCode))
        ?? advertisedModels?.find((candidate) => candidate.code === requestedModel)
        ?? (requestedModel === 'default' && !session.metadata?.currentModelCode ? advertisedModels?.[0] : undefined);
    return { model, resolvedModel };
}

export function resolveMessageCodexPreferenceMeta(
    session: Pick<Session, 'modelMode' | 'metadata' | 'codexPreferences'>,
    machineMetadata?: MachineMetadata | null,
) {
    const { resolvedModel } = resolveMessageModel(session, machineMetadata);
    // Validate at send time even while reply settings are collapsed. The
    // portable Fast preference maps to the selected model's advertised tier.
    return codexPreferenceMeta(session.codexPreferences, resolvedModel?.supportedServiceTiers ?? []);
}

export function resolveMessageModeMeta(
    session: Pick<Session, 'permissionMode' | 'modelMode' | 'effortLevel' | 'metadata'>,
    machineMetadata?: MachineMetadata | null,
): { permissionMode: PermissionModeKey; model: string | null; effort: string | null } {
    const sandboxEnabled = isSandboxEnabled(session.metadata);
    const permissionMode: PermissionModeKey =
        session.permissionMode && session.permissionMode !== 'default'
            ? session.permissionMode
            : (sandboxEnabled ? 'bypassPermissions' : 'default');
    const { model, resolvedModel } = resolveMessageModel(session, machineMetadata);
    const requestedEffort = session.effortLevel;
    const effort = requestedEffort
        && resolvedModel?.supportedEffortLevels?.includes(requestedEffort)
        ? requestedEffort
        : null;

    return {
        permissionMode,
        model,
        effort,
    };
}
