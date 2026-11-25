import type { MachineMetadata, Session } from './storageTypes';
import type { SessionConfigurationValues } from '@hapla/wire';
import { resolveModelCatalog } from '@/components/modelModeOptions';
import { resolveCodexServiceTier } from './codexPreferences';

type Selection = Pick<Session, 'permissionMode' | 'modelMode' | 'effortLevel' | 'metadata' | 'configuration' | 'codexPreferences'>;
function resolveMessageModel(session: Selection, machine?: MachineMetadata | null) {
    const values = session.configuration?.values;
    const requested = values ? values.model : session.modelMode ?? undefined;
    const model = requested === 'default' ? null : requested;
    const catalog = resolveModelCatalog(session.metadata?.flavor, machine, session.metadata);
    const actual = session.metadata?.effectiveConfiguration?.model ?? session.metadata?.currentModelCode;
    const resolved = catalog?.find(row => row.code === (model ?? actual));
    if (model && catalog?.length && !resolved && model !== actual) throw new Error(`模型 ${model} 当前不可用，请重新选择；原设置已保留`);
    return { model, resolved };
}

export function resolveMessageModeMeta(session: Selection, machine?: MachineMetadata | null): SessionConfigurationValues {
    const values = session.configuration?.values;
    const { model, resolved } = resolveMessageModel(session, machine);
    const requested = values ? values.effort : session.effortLevel ?? undefined;
    const effort = requested === 'default' ? null : requested;
    if (effort && resolved?.supportedEffortLevels?.length && !resolved.supportedEffortLevels.includes(effort)) {
        throw new Error(`当前模型不支持 ${effort} 思考强度，请重新选择；原设置已保留`);
    }
    const permissionMode = values?.permissionMode ?? (session.permissionMode && session.permissionMode !== 'default' ? session.permissionMode : undefined);
    return {
        ...(permissionMode !== undefined ? { permissionMode: permissionMode as SessionConfigurationValues['permissionMode'] } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(effort !== undefined ? { effort } : {}),
    };
}

export function resolveMessageCodexPreferenceMeta(session: Selection, machine?: MachineMetadata | null) {
    const values = session.configuration?.values;
    const legacy = session.codexPreferences;
    const { resolved } = resolveMessageModel(session, machine);
    const verbosity = values ? values.verbosity : legacy?.verbosity;
    const tier = values ? values.serviceTier : legacy?.serviceTier;
    const collaborationMode = values ? values.collaborationMode : legacy?.collaborationMode;
    const serviceTier = tier == null || tier === 'default' || tier === 'standard' ? tier
        : resolved?.supportedServiceTiers ? resolveCodexServiceTier(tier, resolved.supportedServiceTiers) : tier;
    if (tier && !['default', 'standard'].includes(tier) && serviceTier === 'default') throw new Error('当前模型不支持所选速度，请重新选择；原设置已保留');
    return {
        ...(verbosity !== undefined ? { verbosity: verbosity === 'default' ? null : verbosity } : {}),
        ...(serviceTier !== undefined ? { serviceTier: serviceTier === 'default' || serviceTier === 'standard' ? null : serviceTier } : {}),
        ...(collaborationMode !== undefined ? { collaborationMode } : {}),
    };
}
