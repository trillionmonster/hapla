import type { SessionConfigurationValues, SessionConfiguration } from '@hapla/wire';
import type { Session } from './storageTypes';
import { defaultCodexPreferences } from './codexPreferences';

export function configurationOwner(session: Session, sessions: Record<string, Session>): string {
    if (session.metadata?.conversationRootSessionId) return session.metadata.conversationRootSessionId;
    if (!session.conversationId) return session.id;
    return Object.values(sessions).filter(row => row.conversationId === session.conversationId)
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))[0]?.id ?? session.id;
}

export function projectSessionConfiguration(session: Session, configuration?: SessionConfiguration): Partial<Session> {
    if (!configuration) return {};
    const values = configuration.values;
    const actual = session.metadata?.effectiveConfiguration;
    return {
        configuration,
        permissionMode: values.permissionMode ?? actual?.permissionMode ?? 'default',
        modelMode: values.model === null ? 'default' : values.model,
        effortLevel: values.effort === null ? 'default' : values.effort ?? actual?.effort,
        codexPreferences: {
            verbosity: values.verbosity ?? 'default',
            serviceTier: values.serviceTier ?? 'default',
            collaborationMode: values.collaborationMode ?? actual?.collaborationMode ?? 'default',
        },
    };
}

export function preferencesPatch(preferences: Partial<typeof defaultCodexPreferences>): SessionConfigurationValues {
    const patch: SessionConfigurationValues = {};
    if (preferences.verbosity !== undefined) patch.verbosity = preferences.verbosity === 'default' ? null : preferences.verbosity;
    if (preferences.serviceTier !== undefined) patch.serviceTier = preferences.serviceTier === 'default' || preferences.serviceTier === 'standard' ? null : preferences.serviceTier;
    if (preferences.collaborationMode !== undefined) patch.collaborationMode = preferences.collaborationMode;
    return patch;
}
