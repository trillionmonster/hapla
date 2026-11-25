import type { Session, Machine } from '@/sync/storageTypes';
import { t } from '@/text';
import { HaplaError } from '@/utils/errors';
import { continuationFlavor, getSessionContinuationAvailability, type SessionContinuationDependencies, type SessionContinuationOptions } from './sessionContinuation';

function resumedRuntimeReady(source: Session, target: Session, options: SessionContinuationOptions): boolean {
    // A daemon-confirmed live process for this exact runtime is reusable. A
    // replacement, however, must not receive the draft merely because its
    // encrypted session row was created before app-server initialization.
    if (target.id === source.id) return true;
    if (!target.active) {
        throw new HaplaError('会话恢复过程中已断开，消息尚未发送。请重试。', true);
    }
    if (continuationFlavor(source) !== 'codex') return true;

    const runtime = target.agentState?.codexRuntime;
    if (runtime?.runtime === 'systemError') {
        throw new HaplaError('Codex 恢复失败，消息尚未发送。请重试。', true);
    }
    const metadata = { ...source.metadata, ...options.metadata };
    const selectedBranch = metadata.codexBranches?.find(branch => branch.id === metadata.activeCodexBranchId);
    const requestedThread = options.metadata?.codexThreadId ?? selectedBranch?.threadId ?? metadata.codexThreadId;

    // A genuinely new conversation creates its first thread only when its
    // first question arrives. `notLoaded` is a valid initialized state there.
    if (!requestedThread) return !runtime || runtime.runtime !== 'loading';
    if (!runtime) {
        // Existing protocol-aware clients must wait for their new runtime's
        // state. Legacy CLIs never published it; their daemon readiness ACK
        // remains the compatibility signal.
        return !source.agentState?.codexRuntime;
    }
    if (runtime.runtime === 'loading' || runtime.runtime === 'notLoaded') return false;
    if (runtime.threadId !== requestedThread) {
        throw new HaplaError('恢复的 Codex 会话与所选分支不一致，消息尚未发送。', true);
    }
    return runtime.runtime === 'idle' || runtime.runtime === 'active';
}

export async function prepareSessionForSend(
    session: Session,
    machine: Machine | null | undefined,
    isConnected: boolean,
    dependencies: SessionContinuationDependencies,
    options: SessionContinuationOptions = {},
): Promise<string> {
    const flavor = continuationFlavor(session);
    const availability = getSessionContinuationAvailability(session, machine, isConnected);
    if (!availability.requiresContinuation) {
        return session.id;
    }
    if (!availability.canContinue) {
        throw new HaplaError(availability.message, true);
    }

    const machineId = machine?.id;
    if (!machineId) {
        throw new HaplaError(t('sessionInfo.resumeSessionMissingMachine'), true);
    }

    const result = await dependencies.resumeSession({
        machineId,
        sessionId: session.id,
        conversationId: session.conversationId ?? session.id,
        metadata: {
            launchSpecId: session.metadata?.launchSpecId,
            executionConfiguration: session.configuration ?? session.metadata?.executionConfiguration,
            path: session.metadata?.path ?? '',
            flavor: flavor ?? session.metadata?.flavor,
            codexThreadId: session.metadata?.codexThreadId,
            claudeSessionId: session.metadata?.claudeSessionId,
            conversationRootSessionId: session.metadata?.conversationRootSessionId,
            codexBranches: session.metadata?.codexBranches,
            activeCodexBranchId: session.metadata?.activeCodexBranchId,
            ...options.metadata,
        },
    });

    switch (result.type) {
        case 'requestToApproveDirectoryCreation':
            throw new HaplaError(t('sessionInfo.resumeSessionUnexpectedDirectoryPrompt'), false);
        case 'error':
            throw new HaplaError(result.errorMessage, true);
        case 'success': {
            const refreshAttempts = dependencies.refreshAttempts ?? 20;
            for (let attempt = 0; attempt < refreshAttempts; attempt++) {
                await dependencies.refreshSessions();
                const target = dependencies.getSession(result.sessionId);
                if (target && resumedRuntimeReady(session, target, options)) {
                    dependencies.copySessionSettings(session, result.sessionId);
                    return result.sessionId;
                }
                if (attempt + 1 < refreshAttempts) {
                    await dependencies.wait(250);
                }
            }
            throw new HaplaError(t('errors.connectionTimeout'), true);
        }
    }
}
