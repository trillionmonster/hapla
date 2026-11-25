import { TurnInputLedger } from './turnInputLedger';
import { sessionConfigurationValuesSchema } from '@hapla/wire/sessionConfiguration';
import { prepareRuntimeLaunch } from '@/resume/runtimeLaunchSpec';
import { installCodexCheckpoints } from '@/modules/git/codexCheckpoints';
import { render } from "ink";
import React from "react";
import { ApiClient } from '@/api/api';
import { CodexAppServerClient } from './codexAppServerClient';
import { CodexTurnFailure } from './codexTurnFailure';
import { CodexPermissionHandler } from './utils/permissionHandler';
import { DiffProcessor } from './utils/diffProcessor';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { logger } from '@/ui/logger';
import { Credentials, readSettings } from '@/persistence';
import { initialMachineMetadata } from '@/daemon/run';
import { configuration } from '@/configuration';
import packageJson from '../../package.json';
import { CodexInputQueue } from './codexInputQueue';
import { CodexSideChats } from './codexSideChats';
import { hashObject } from '@/utils/deterministicJson';
import { projectPath } from '@/projectPath';
import { join } from 'node:path';
import { createSessionMetadata } from '@/utils/createSessionMetadata';
import { startHaplaServer } from '@/claude/utils/startHaplaServer';
import { MessageBuffer } from "@/ui/ink/messageBuffer";
import { CodexDisplay } from "@/ui/ink/CodexDisplay";
import { trimIdent } from "@/utils/trimIdent";
import { CHANGE_TITLE_INSTRUCTION } from '@/utils/agentInstructions';
import { notifyDaemonSessionStarted } from "@/daemon/controlClient";
import { runCodexStartup } from './startupReadiness';
import { connectionState } from '@/utils/serverConnectionErrors';
import { setupOfflineReconnection } from '@/utils/setupOfflineReconnection';
import type { ApiSessionClient } from '@/api/apiSession';
import { resolveCodexExecutionPolicy } from './executionPolicy';
import { mapCodexMcpMessageToSessionEnvelopes, mapCodexProcessorMessageToSessionEnvelopes } from './utils/sessionProtocolMapper';
import { resumeExistingThread } from './resumeExistingThread';
import { emitReadyIfIdle } from './emitReadyIfIdle';
import { getCodexInputItemsAsync, getUserMessageImages, getUserMessageText } from '@/utils/userMessageContent';
import { prepareGeneratedMediaArtifact } from './generatedImageUploads';
import { createEnvelope, isCodexTurnRunning, reduceCodexRuntimeEvent, type CodexRuntimeState } from '@hapla/wire';
import { detectCodexVersion, discoverCodexModels, mapCodexModelsToMetadata } from './modelDiscovery';
import type { InputItem } from './codexAppServerTypes';
import { discoverInteractiveSkillServers } from '@/skills/interactiveSkillManifest';
import { CodexSessionStreamBuffer } from './utils/sessionStreamBuffer';
import { CommandOutputStore } from './utils/commandOutputStore';
import { assertCodexAbortTarget } from './utils/abortTarget';
import { RuntimeSleepBarrier } from './utils/runtimeSleepBarrier';
import { RuntimeTurnBarrier } from './utils/runtimeTurnBarrier';
import { resolveCodexExecutable } from './utils/resolveCodexExecutable';
import { resolveCodexForkPoint } from './threadBranching';
import { captureTurnMediaBaseline, discoverTurnMediaCandidates } from '@/modules/common/turnMediaArtifacts';
import { TurnArtifactDelivery, isCompletedArtifactStep, type ArtifactStep } from '@/modules/common/turnArtifactDelivery';
import { ArtifactDeliveryLedger } from '@/modules/common/artifactDeliveryLedger';
import { realpath as mediaRealpath } from 'node:fs/promises';
import { GENERATED_MEDIA_ROOT } from '@/modules/common/mediaFiles';

const GENERATED_MEDIA_DISPLAY_INSTRUCTION = [
    '',
    'Hapla collects generated media beside completed steps. Generated images are uploaded automatically; workspace video and audio originals are opened on demand.',
    'Explain the key or final deliverables in your reply and link only the results the user should inspect. Do not list every intermediate clip, copy files, or run extra local-preview commands solely to display them.',
    'If image generation fails, report the exact provider error. Do not describe an HTTP 401 or an IP authorization rejection as a network-permission or sandbox failure.',
].join('\n');

export function shouldAppendGeneratedImageDisplayInstruction(message: string): boolean {
    return /imagegen|生成.*图|画.*图|绘图|作图|图片|图像|视频|音频|录音|配音|image|picture|photo|draw|video|audio|media/i.test(message);
}

type InteractiveAppScope = {
    server: string;
    resourceUri: string;
    sourceTool: string;
    lastSeenAt: number;
    callTimestamps: number[];
};

function serializedSize(value: unknown): number {
    return Buffer.byteLength(JSON.stringify(value ?? null), 'utf8');
}

function isSafeInteractiveImageUrl(value: string): boolean {
    return /^https:\/\//i.test(value) || /^data:image\/(png|jpeg|webp|gif);base64,/i.test(value);
}

/**
 * Main entry point for the codex command with ink UI
 */
export async function runCodex(opts: {
    credentials: Credentials;
    startedBy?: 'daemon' | 'terminal';
    noSandbox?: boolean;
    resumeThreadId?: string;
    codexArgs?: string[];
}): Promise<void> {
    // Early check: ensure Codex CLI is installed before proceeding
    try {
        execFileSync(resolveCodexExecutable(), ['--version'], { encoding: 'utf8', stdio: 'pipe', windowsHide: true });
    } catch (error) {
        if (error instanceof Error && error.message.includes('Prepared Codex runtime')) throw error;
        console.error('\n\x1b[1m\x1b[33mCodex CLI is not installed\x1b[0m\n');
        console.error('Please install Codex CLI using one of these methods:\n');
        console.error('\x1b[1mOption 1 - npm (recommended):\x1b[0m');
        console.error('  \x1b[36mnpm install -g @openai/codex\x1b[0m\n');
        console.error('\x1b[1mOption 2 - Homebrew (macOS):\x1b[0m');
        console.error('  \x1b[36mbrew install --cask codex\x1b[0m\n');
        console.error('Alternatively, use Claude Code:');
        console.error('  \x1b[36mhapla\x1b[0m\n');
        process.exit(1);
    }

    // Use shared PermissionMode type for cross-agent compatibility
    type PermissionMode = import('@/api/types').PermissionMode;
    interface EnhancedMode {
        sourceMessageId?: string;
        sourceMessageCreatedAt?: number;
        branchId?: string;
        permissionMode: PermissionMode;
        model?: string | null;
        effort?: import('./codexAppServerTypes').ReasoningEffort | null;
        verbosity?: 'low' | 'medium' | 'high' | null;
        serviceTier?: string | null;
        collaborationMode?: 'default' | 'plan';
    }

    //
    // Define session
    //

    const sessionTag = randomUUID();

    // Set backend for offline warnings (before any API calls)
    connectionState.setBackend('Codex');

    const api = await ApiClient.create(opts.credentials);

    // Log startup options
    logger.debug(`[codex] Starting with options: startedBy=${opts.startedBy || 'terminal'} codexArgs=${JSON.stringify(opts.codexArgs ?? [])}`);

    //
    // Machine
    //

    const settings = await readSettings();
    let machineId = settings?.machineId;
    const sandboxConfig = opts.noSandbox ? undefined : settings?.sandboxConfig;
    if (!machineId) {
        console.error('[START] No machine ID found in settings. Run `hapla doctor` and report the diagnostic output.');
        process.exit(1);
    }
    logger.debug(`Using machineId: ${machineId}`);
    prepareRuntimeLaunch('codex', opts.codexArgs ?? [], opts.noSandbox);
    const codexModels = await discoverCodexModels(opts.codexArgs ?? []);
    await api.getOrCreateMachine({
        machineId,
        metadata: {
            ...initialMachineMetadata,
            codexVersion: detectCodexVersion(),
            codexModels,
        }
    });

    //
    // Create session
    //

    const { state, metadata } = createSessionMetadata({
        flavor: 'codex',
        machineId,
        startedBy: opts.startedBy,
        sandbox: sandboxConfig,
    });
    const response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });

    // Handle server unreachable case - create offline stub with hot reconnection
    let session: ApiSessionClient;
    // Permission handler declared here so it can be updated in onSessionSwap callback
    // (assigned later at line ~385 after client setup)
    let permissionHandler: CodexPermissionHandler;
    let client!: CodexAppServerClient;
    let reattachCodingCheckpoints: ((next: ApiSessionClient) => void) | undefined;
    let abortInProgress: Promise<void> | null = null;
    let resumeArtifactBacklog = () => {};
    const { session: initialSession, reconnectionHandle } = setupOfflineReconnection({
        api,
        sessionTag,
        metadata,
        state,
        response,
        onSessionSwap: (newSession) => {
            session = newSession;
            reattachCodingCheckpoints?.(newSession);
            newSession.on('connected', resumeArtifactBacklog);
            resumeArtifactBacklog();
            // Update permission handler with new session to avoid stale reference
            if (permissionHandler) {
                permissionHandler.updateSession(newSession);
            }
        }
    });
    session = initialSession;

    const messageQueue = new CodexInputQueue<EnhancedMode>((mode) => hashObject({
        permissionMode: mode.permissionMode,
        model: mode.model,
        effort: mode.effort,
        verbosity: mode.verbosity, serviceTier: mode.serviceTier, collaborationMode: mode.collaborationMode,
        branchId: mode.branchId,
    }), join(configuration.haplaHomeDir, 'codex-inputs', `${session.getMetadata()?.conversationRootSessionId ?? session.sessionId}.json`), () => {
        const { paused, items, receipts } = messageQueue.snapshot();
        session.updateAgentState(state => ({ ...state, codexInputs: { paused, receipts, items: items.map(({ id, message, revision, createdAt, error }) => ({ id, message, revision, createdAt, error })) } }));
    });
    let inputSubmission: Promise<void> = Promise.resolve();
    let mainTurnInputText = '';
    let activeSourceMessageId: string | undefined;
    const turnInputs = new TurnInputLedger(join(configuration.haplaHomeDir, 'codex-turn-inputs', `${session.getMetadata()?.conversationRootSessionId ?? session.sessionId}.json`));
    let sideChats: CodexSideChats | undefined;
    const interactiveAppScopes = new Map<string, InteractiveAppScope>();
    const sessionStreams = new CodexSessionStreamBuffer((snapshot) => session.sendSessionStream(snapshot));
    const commandOutputs = new CommandOutputStore(process.cwd(), sessionTag, (error) => {
        logger.warn('[Codex] Failed to preserve complete command output log', error);
    });
    let activeInteractiveToolCalls = 0;
    let abortController = new AbortController();
    let shouldExit = false;
    const sleepBarrier = new RuntimeSleepBarrier();
    let pendingInputPreparations = 0;
    let hasUnsubmittedInput = false;
    const turnBarrier = new RuntimeTurnBarrier(() => client.waitForTurnIdle(), (error) => {
        logger.warn('[Codex] Provider is unavailable; retaining queued input', error);
        session.sendSessionEvent({ type: 'message', message: 'Codex is unavailable. Queued messages are retained and will wait until the runtime is restored.' });
    });
    const reasoningSummaryParts = new Map<string, Map<number, string>>();


    // Track current overrides to apply per message
    // Use shared PermissionMode type from api/types for cross-agent compatibility
    let currentPermissionMode: import('@/api/types').PermissionMode = session.getMetadata()?.executionConfiguration?.values.permissionMode ?? 'default';
    let currentModel: string | null | undefined = undefined;
    let submittedModel: string | undefined;
    let currentEffort: import('./codexAppServerTypes').ReasoningEffort | null | undefined = undefined;
    let currentVerbosity: EnhancedMode['verbosity'];
    let currentServiceTier: EnhancedMode['serviceTier'];
    let currentCollaborationMode: EnhancedMode['collaborationMode'];

    session.onUserMessage((message) => {
        sleepBarrier.noteInput();
        // Resolve permission mode (accept all modes, will be mapped in switch statement)
        let messagePermissionMode = currentPermissionMode;
        if (message.meta?.permissionMode) {
            messagePermissionMode = message.meta.permissionMode as import('@/api/types').PermissionMode;
            logger.debug(`[Codex] Permission mode updated from user message to: ${currentPermissionMode}`);
        } else {
            logger.debug(`[Codex] User message received with no permission mode override, using current: ${currentPermissionMode}`);
        }

        // Resolve model; explicit null resets to default (undefined)
        let messageModel = currentModel;
        if (message.meta?.hasOwnProperty('model')) {
            messageModel = message.meta.model;
            logger.debug(`[Codex] Model updated from user message: ${messageModel || 'reset to default'}`);
        } else {
            logger.debug(`[Codex] User message received with no model override, using current: ${currentModel || 'default'}`);
        }

        let messageEffort = currentEffort;
        if (message.meta?.hasOwnProperty('effort')) {
            messageEffort = message.meta.effort
                ? message.meta.effort as import('./codexAppServerTypes').ReasoningEffort
                : null;
            logger.debug(`[Codex] Effort updated from user message: ${messageEffort || 'reset to default'}`);
        }

        const enhancedMode: EnhancedMode = {
            permissionMode: messagePermissionMode,
            model: messageModel,
            effort: messageEffort,
            verbosity: message.meta?.hasOwnProperty('verbosity') ? message.meta.verbosity : currentVerbosity, serviceTier: message.meta?.hasOwnProperty('serviceTier') ? message.meta.serviceTier : currentServiceTier, collaborationMode: message.meta?.collaborationMode ?? currentCollaborationMode,
        };
        enhancedMode.branchId = message.meta?.branchId;
        enhancedMode.sourceMessageId = message.delivery?.id;
        enhancedMode.sourceMessageCreatedAt = message.delivery?.createdAt;
        const id = message.meta?.codexInputId ?? randomUUID();
        const text = getUserMessageText(message);
        inputSubmission = inputSubmission.then(async () => {
            if (messageQueue.has(id)) return;
            pendingInputPreparations++;
            try {
                const input = await getCodexInputItemsAsync(message, { serverUrl: configuration.serverUrl, token: session.authToken });
                if (enhancedMode.branchId && client.threadId && enhancedMode.branchId !== activeCodexBranchId) {
                    messageQueue.pushMultimodal(input, enhancedMode, id, true);
                    messageQueue.fail(id, '这条消息属于其他分支，请切换到对应分支后重试');
                    return;
                }
                currentPermissionMode = enhancedMode.permissionMode;
                currentModel = enhancedMode.model;
                currentEffort = enhancedMode.effort;
                currentVerbosity = enhancedMode.verbosity;
                currentServiceTier = enhancedMode.serviceTier;
                currentCollaborationMode = enhancedMode.collaborationMode;
                const delivery = message.meta?.codexFollowupMode ?? 'steer';
                const steer = delivery === 'steer' && !!(client?.turnId || client?.startId) && !abortInProgress;
                messageQueue.pushMultimodal(input, enhancedMode, id, steer || delivery === 'replace');
                if (delivery === 'replace') {
                    try {
                        if (client?.turnId || client?.startId) {
                            if (!message.meta?.codexInterruptTarget) throw new Error('缺少要停止的任务标识，请刷新后重试');
                            await handleAbort({ ...message.meta.codexInterruptTarget, requestId: `replace:${id}` });
                        }
                        messageQueue.release(id); messageQueue.start(id);
                    } catch (error) { messageQueue.fail(id, error instanceof Error ? error.message : String(error)); }
                } else if (steer) {
                    try {
                        const deadline = Date.now() + 15_000;
                        while (client.startId && !client.turnId && !abortInProgress && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
                        if (!client.turnId && !client.startId) { messageQueue.release(id); messageQueue.start(id); }
                        else {
                            if (enhancedMode.branchId && enhancedMode.branchId !== activeCodexBranchId) throw new Error('分支已变化，请切换回消息所属分支');
                            await client.steerTurnContent(input as InputItem[], id);
                            turnInputs.record(enhancedMode.sourceMessageId, { threadId: client.threadId!, turnId: client.turnId!, steered: true });
                            mainTurnInputText += `\n${text}`;
                            messageQueue.acknowledge(id, 'steered');
                        }
                    } catch (error) {
                        // Ambiguous failures require an explicit retry; never
                        // silently cancel a turn or duplicate a submitted input.
                        messageQueue.fail(id, error instanceof Error ? error.message : String(error));
                    }
                } else if (delivery !== 'queue') messageQueue.start(id);
            } finally { pendingInputPreparations--; }
        }).catch(error => {
            logger.warn('[Codex] Follow-up submission failed', error instanceof Error ? error.message : String(error));
            session.sendSessionEvent({ type: 'message', message: `追问提交失败：${error instanceof Error ? error.message : String(error)}` });
        });
    });
    let thinking = false;
    let codexRuntime: CodexRuntimeState | null = null;
    const getCodexRuntime = (): CodexRuntimeState | null => codexRuntime;
    let lastProtocolSequence = -1;
    let currentTurnId: string | null = null;
    let lastCompletedTurnId: string | null = null;
    let codexStartedSubagents = new Set<string>();
    let codexActiveSubagents = new Set<string>();
    let codexProviderSubagentToSessionSubagent = new Map<string, string>();
    let turnMediaDelivery: TurnArtifactDelivery | null = null;
    const artifactLedger = new ArtifactDeliveryLedger({
        onError: error => logger.warn('[Codex] Generated artifact remains pending', error),
    });
    let artifactRecoveryController: AbortController | null = null;
    const cancelArtifactRecovery = () => artifactRecoveryController?.abort();
    resumeArtifactBacklog = () => {
        if (!artifactLedger.pendingCount || artifactRecoveryController) return;
        const controller = new AbortController();
        artifactRecoveryController = controller;
        void artifactLedger.drain(controller.signal).catch(error => {
            if (!controller.signal.aborted) logger.warn('[Codex] Could not retry pending generated artifacts', error);
        }).finally(() => {
            if (artifactRecoveryController === controller) artifactRecoveryController = null;
        });
    };
    // The bootstrap offline bridge has no EventEmitter until it is swapped;
    // onSessionSwap above installs this same listener on the real client.
    session.on?.('connected', resumeArtifactBacklog);
    let currentActivity: { phase: string; detail?: string; itemType?: string } | null = null;
    const publishActivity = (next: typeof currentActivity) => {
        if (JSON.stringify(next) === JSON.stringify(currentActivity)) return;
        currentActivity = next;
        session.keepAlive(thinking, 'remote', currentActivity);
    };
    session.keepAlive(thinking, 'remote', currentActivity);
    // Periodic keep-alive; store handle so we can clear on exit
    const keepAliveInterval = setInterval(() => {
        session.keepAlive(thinking, 'remote', currentActivity);
    }, 2000);

    const sendReady = () => {
        session.sendSessionEvent({ type: 'ready' });
    };

    const artifactStep = (turnId: string, sourceId?: string, branchId = activeCodexBranchId, time = Date.now()): ArtifactStep => ({
        turnId, branchId, sourceId, time, batchId: `artifacts:${turnId}:${sourceId ?? 'remaining'}`,
    });

    // Debug helper: log active handles/requests if DEBUG is enabled
    function logActiveHandles(tag: string) {
        if (!process.env.DEBUG) return;
        const anyProc: any = process as any;
        const handles = typeof anyProc._getActiveHandles === 'function' ? anyProc._getActiveHandles() : [];
        const requests = typeof anyProc._getActiveRequests === 'function' ? anyProc._getActiveRequests() : [];
        logger.debug(`[codex][handles] ${tag}: handles=${handles.length} requests=${requests.length}`);
        try {
            const kinds = handles.map((h: any) => (h && h.constructor ? h.constructor.name : typeof h));
            logger.debug(`[codex][handles] kinds=${JSON.stringify(kinds)}`);
        } catch { }
    }

    //
    // Abort handling
    // IMPORTANT: There are two different operations:
    // 1. Abort (handleAbort): Stops the current inference/task but keeps the session alive
    //    - Used by the 'abort' RPC from mobile app
    //    - Similar to Claude Code's abort behavior
    //    - Allows continuing with new prompts after aborting
    // 2. Runtime stop (handleKillSession): Stops the process but preserves the
    //    resumable conversation. The legacy RPC name remains wire-compatible.
    //

    // AbortController is used ONLY to wake messageQueue.waitForMessages when idle.
    // Turn cancellation uses client.interruptTurn() — no AbortController hack needed.
    /**
     * Handles aborting the current task/inference without exiting the process.
     * This is the equivalent of Claude Code's abort - it stops what's currently
     * happening but keeps the session alive for new prompts.
     */
    async function handleAbort(params?: unknown) {
        const capturedRuntime = getCodexRuntime();
        assertCodexAbortTarget(params, {
            epoch: capturedRuntime?.epoch ?? null,
            threadId: client?.threadId ?? null,
            turnId: client?.turnId ?? null,
            turn: capturedRuntime?.turn,
            startId: capturedRuntime?.startId,
        });
        messageQueue.pause();
        turnMediaDelivery?.cancel();
        cancelArtifactRecovery();
        if (abortInProgress) {
            await abortInProgress;
            return;
        }

        logger.debug('[Codex] Abort requested - stopping current task');
        abortInProgress = (async () => {
            try {
                // Resolve any pending permission requests as 'abort' first.
                if (permissionHandler) {
                    permissionHandler.abortThread(client.threadId);
                }

                // A timeout leaves interruption unconfirmed and retryable.
                if (client) {
                    const targetTurnId = client.turnId;
                    const abortResult = await client.abortTurnWithFallback({
                        gracePeriodMs: 3000,
                        forceRestartOnTimeout: false,
                        ...(targetTurnId ? { expectedTurnId: targetTurnId }
                            : capturedRuntime?.startId ? { expectedStartId: capturedRuntime.startId } : {}),
                    });
                    const runtime = getCodexRuntime();
                    const stillRunning = runtime
                        ? (targetTurnId === null || runtime.turnId === targetTurnId) && isCodexTurnRunning(runtime)
                        : client.turnId === targetTurnId && targetTurnId !== null;
                    if (abortResult.hadActiveTurn && !abortResult.aborted && stillRunning) {
                        throw new Error('Codex interruption was not confirmed. The turn is still running; retry the stop request.');
                    }
                }

                logger.debug('[Codex] Abort completed - session remains active');
            } catch (error) {
                logger.debug('[Codex] Error during abort:', error);
                throw error;
            } finally {
                // Wake up message queue wait if idle
                abortController.abort();
                abortController = new AbortController();
            }
        })();

        try {
            await abortInProgress;
        } finally {
            abortInProgress = null;
        }
    }

    /**
     * Stops the runtime while preserving the resumable conversation.
     */
    let sleepShutdownScheduled = false;
    const restoreAwakeMetadata = () => session.updateMetadata((metadata) => ({
        ...metadata, lifecycleState: 'running', lifecycleStateSince: Date.now(), sleepReason: undefined,
    }));
    const handleKillSession = async () => {
        let persistedSleep = false;
        try {
            await sleepBarrier.prepare(async () => {
                if (messageQueue.size() > 0 || pendingInputPreparations > 0 || hasUnsubmittedInput) {
                    throw new Error('Messages are waiting to run. Wait for them to finish before putting the session to sleep.');
                }
                await handleAbort();
                if (messageQueue.size() > 0 || pendingInputPreparations > 0 || hasUnsubmittedInput) {
                    throw new Error('A new message is waiting; the runtime remains awake.');
                }
                await session.updateMetadata((metadata) => ({
                    ...metadata,
                    lifecycleState: 'sleeping',
                    lifecycleStateSince: Date.now(),
                    sleepReason: 'runtime-stop',
                }));
                persistedSleep = true;
                await session.flush();
            });
            if (!sleepShutdownScheduled) {
                sleepShutdownScheduled = true;
                // Return the encrypted RPC response before the main loop closes its transport.
                setTimeout(() => {
                    sleepShutdownScheduled = false;
                    if (!sleepBarrier.commit()) {
                        void restoreAwakeMetadata().catch((error) => logger.warn('[Codex] Failed to persist transparent wake', error));
                        return;
                    }
                    shouldExit = true;
                    turnBarrier.close();
                    abortController.abort();
                }, 0);
            }
            return { success: true, message: 'Session is sleeping and can be resumed by sending a message.' };
        } catch (error) {
            if (persistedSleep) await restoreAwakeMetadata();
            logger.warn('[Codex] Manual sleep failed; runtime remains available', error);
            return { success: false, message: error instanceof Error ? error.message : String(error) };
        }
    };

    // Register abort handler
    session.rpcHandlerManager.registerHandler('abort', handleAbort);

    session.rpcHandlerManager.registerHandler('killSession', handleKillSession);

    //
    // Initialize Ink UI
    //

    const messageBuffer = new MessageBuffer();
    const hasTTY = process.stdout.isTTY && process.stdin.isTTY;
    let inkInstance: any = null;

    if (hasTTY) {
        console.clear();
        inkInstance = render(React.createElement(CodexDisplay, {
            messageBuffer,
            logPath: process.env.DEBUG ? logger.getLogPath() : undefined,
            onExit: async () => {
                // Exit the agent
                logger.debug('[codex]: Exiting agent via Ctrl-C');
                shouldExit = true;
                turnBarrier.close();
                await handleAbort();
            }
        }), {
            exitOnCtrlC: false,
            patchConsole: false
        });
    }

    if (hasTTY) {
        process.stdin.resume();
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
        }
        process.stdin.setEncoding("utf8");
    }

    //
    // Start Context 
    //

    client = new CodexAppServerClient(sandboxConfig, opts.codexArgs ?? []);
    client.setConfigurationHandler(configuration => {
        if (configuration.permissionMode) currentPermissionMode = configuration.permissionMode;
        void session.updateMetadata(metadata => ({ ...metadata, effectiveConfiguration: configuration,
            currentModelCode: configuration.model ?? metadata.currentModelCode,
            currentThoughtLevelCode: configuration.effort ?? undefined,
            currentOperatingModeCode: configuration.permissionMode ?? metadata.currentOperatingModeCode,
        }));
    });
    session.attachCodexProtocolJournal(client.protocolJournalPath);
    let activeCodexBranchId = session.getMetadata()?.activeCodexBranchId ?? 'main';
    const codingCheckpoints = installCodexCheckpoints({ session, client, root: process.cwd(),
        branch: () => activeCodexBranchId, setBranch: id => { activeCodexBranchId = id; },
        isBusy: () => thinking || hasUnsubmittedInput || pendingInputPreparations > 0 || activeInteractiveToolCalls > 0 || codexActiveSubagents.size > 0 || messageQueue.size() > 0 || sideChats?.snapshot().some(chat => chat.status === 'running' || chat.status === 'stopping') === true,
    });

    reattachCodingCheckpoints = codingCheckpoints.attach;

    const waitForCodexThread = async (): Promise<void> => {
        const deadline = Date.now() + 15_000;
        while (!client.threadId && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (!client.threadId) throw new Error('The Codex thread did not become ready in time.');
    };

    session.rpcHandlerManager.registerHandler('codex-thread-fork', async (params: any) => {
        if (thinking) throw new Error('Wait for the active turn to finish before editing history.');
        // A transparently resumed Hapla session is announced as soon as its
        // encrypted transport exists. The app-server thread may need another
        // moment to finish thread/resume; keep the single fork RPC pending until
        // that state is ready instead of racing it or asking the user to retry.
        await waitForCodexThread();
        const inputIdentity = typeof params?.forkMessageId === 'string' ? turnInputs.get(params.forkMessageId) : undefined;
        if (inputIdentity?.steered) throw new Error('这条补充属于同一执行轮次，无法单独从中间编辑；请编辑该轮的第一条问题');
        const turns = await client.readThreadTurns();
        const forkPoint = resolveCodexForkPoint(turns, {
            turnId: inputIdentity?.turnId,
            userOrdinal: params?.userOrdinal,
            userText: params?.userText,
        });
        if (!forkPoint) {
            throw new Error('Could not match this message to a persisted Codex turn.');
        }
        const parentId = activeCodexBranchId;
        const { previousTurnId } = forkPoint;
        const fork = previousTurnId
            ? await client.forkThread({ lastTurnId: previousTurnId, cwd: process.cwd() })
            : await client.startSiblingThread({ cwd: process.cwd() });
        const branchId = fork.threadId;
        activeCodexBranchId = branchId;
        const label = typeof params?.label === 'string' && params.label.trim()
            ? params.label.trim().slice(0, 80)
            : `Edit ${new Date().toLocaleTimeString()}`;
        session.updateMetadata((metadata) => {
            const existing = metadata.codexBranches ?? [{
                id: parentId,
                threadId: fork.forkedFromId,
                label: 'Original',
                createdAt: Date.now(),
            }];
            return {
                ...metadata,
                codexThreadId: branchId,
                activeCodexBranchId: branchId,
                codexBranches: [...existing, {
                    id: branchId,
                    threadId: branchId,
                    label,
                    parentId,
                    forkMessageId: typeof params?.forkMessageId === 'string' ? params.forkMessageId : undefined,
                    forkMessageCreatedAt: typeof params?.forkMessageCreatedAt === 'number'
                        ? params.forkMessageCreatedAt
                        : undefined,
                    createdAt: Date.now(),
                }],
            };
        });
        return { branchId, threadId: branchId, parentId, label };
    });

    session.rpcHandlerManager.registerHandler('codex-thread-switch', async (params: any) => {
        if (thinking) throw new Error('Wait for the active turn to finish before switching branches.');
        await waitForCodexThread();
        const branchId = typeof params?.branchId === 'string' ? params.branchId : '';
        const metadata = session.getMetadata();
        const branch = metadata?.codexBranches?.find((candidate) => candidate.id === branchId);
        if (!branch) throw new Error('Unknown Codex branch.');
        const resumed = await client.resumeThread({ threadId: branch.threadId, cwd: process.cwd() });
        activeCodexBranchId = branch.id;
        session.updateMetadata((current) => ({
            ...current,
            codexThreadId: resumed.threadId,
            activeCodexBranchId: branch.id,
            currentModelCode: resumed.model,
        }));
        return { branchId: branch.id, threadId: resumed.threadId };
    });

    session.rpcHandlerManager.registerHandler('codex-thread-status', async () => {
        await waitForCodexThread();
        return {
            branchId: activeCodexBranchId,
            threadId: client.threadId!,
        };
    });

    session.rpcHandlerManager.registerHandler('codex-thread-fork-current', async (params: any) => {
        await waitForCodexThread();
        const parentId = activeCodexBranchId;
        const sourceThreadId = client.threadId!;
        const createdAt = Date.now();
        const result = await client.requestRaw<{ thread: { id: string } }>('thread/fork', { threadId: sourceThreadId, cwd: process.cwd(), deferGoalContinuation: true });
        const label = typeof params?.label === 'string' && params.label.trim() ? params.label.trim().slice(0, 80) : '新分支';
        await session.updateMetadata(metadata => ({ ...metadata, codexBranches: [...(metadata.codexBranches ?? [{ id: parentId, threadId: sourceThreadId, label: 'Original', createdAt }]), {
            id: result.thread.id, threadId: result.thread.id, parentId, label, createdAt, forkMessageCreatedAt: createdAt,
        }] }));
        return { branchId: result.thread.id, parentId, label };
    });

    const requireInteractiveAppScope = (server: unknown, resourceUri: unknown): InteractiveAppScope => {
        if (typeof server !== 'string' || typeof resourceUri !== 'string') {
            throw new Error('Interactive app server and resourceUri are required.');
        }
        const scope = interactiveAppScopes.get(resourceUri);
        if (!scope || scope.server !== server) {
            throw new Error('This MCP App resource was not opened by the active Codex session.');
        }
        return scope;
    };

    session.rpcHandlerManager.registerHandler('codex-mcp-resource-read', async (params: any) => {
        const scope = requireInteractiveAppScope(params?.server, params?.resourceUri);
        const response = await client.readMcpResource(scope.server, scope.resourceUri);
        if (serializedSize(response) > 2 * 1024 * 1024) {
            throw new Error('MCP App resource exceeds Hapla’s 2 MiB limit.');
        }
        return response;
    });

    session.rpcHandlerManager.registerHandler('codex-mcp-tool-call', async (params: any) => {
        const scope = requireInteractiveAppScope(params?.server, params?.resourceUri);
        if (typeof params?.tool !== 'string' || !/^[a-zA-Z0-9_.:/-]{1,160}$/.test(params.tool)) {
            throw new Error('Invalid MCP tool name.');
        }
        if (serializedSize(params?.arguments) > 256 * 1024) {
            throw new Error('MCP App tool arguments exceed Hapla’s 256 KiB limit.');
        }

        const now = Date.now();
        scope.callTimestamps = scope.callTimestamps.filter((timestamp) => now - timestamp < 60_000);
        if (scope.callTimestamps.length >= 30) {
            throw new Error('MCP App call rate exceeded (30 calls per minute).');
        }
        if (activeInteractiveToolCalls >= 4) {
            throw new Error('Too many MCP App calls are already running.');
        }
        scope.callTimestamps.push(now);
        activeInteractiveToolCalls += 1;
        try {
            return await client.callMcpTool(scope.server, params.tool, params.arguments ?? {}, params.meta);
        } finally {
            activeInteractiveToolCalls -= 1;
        }
    });

    session.rpcHandlerManager.registerHandler('codex-interactive-submit', async (params: any) => {
        const scope = requireInteractiveAppScope(params?.server, params?.resourceUri);
        const text = typeof params?.text === 'string' ? params.text.trim() : '';
        if (!text || text.length > 64_000) {
            throw new Error('Interactive submission text must be between 1 and 64,000 characters.');
        }

        const input: InputItem[] = [{ type: 'text', text }];
        const images = Array.isArray(params?.images) ? params.images : [];
        if (images.length > 12) {
            throw new Error('Interactive submissions support at most 12 images.');
        }
        for (const image of images) {
            if (typeof image !== 'string' || !isSafeInteractiveImageUrl(image) || image.length > 2 * 1024 * 1024) {
                throw new Error('Interactive image references must be HTTPS URLs or small image data URLs.');
            }
            input.push({ type: 'image', url: image });
        }

        if (params?.skill != null) {
            const requestedName = params.skill?.name;
            const requestedPath = params.skill?.path;
            const installedSkills = await client.listSkills(process.cwd(), false);
            const matches = installedSkills.filter((skill) => (
                skill.enabled
                && skill.name === requestedName
                && (requestedPath == null || skill.path === requestedPath)
            ));
            const installed = matches.length === 1 ? matches[0] : null;
            if (!installed) {
                throw new Error(matches.length > 1
                    ? 'The hand-off Skill name is ambiguous; include its exact SKILL.md path.'
                    : 'The requested hand-off Skill is not enabled in this Codex workspace.');
            }
            input.push({ type: 'skill', name: installed.name, path: installed.path });
        }

        const source = `Interactive MCP App ${scope.server}/${scope.sourceTool}`;
        input[0] = { type: 'text', text: `${text}\n\n[Submitted from ${source}]` };
        messageQueue.pushMultimodal(input, {
            permissionMode: currentPermissionMode,
            model: currentModel,
            effort: currentEffort,
            verbosity: currentVerbosity, serviceTier: currentServiceTier, collaborationMode: currentCollaborationMode,
        });
        sleepBarrier.noteInput();
        session.sendSessionProtocolMessage(createEnvelope('user', { t: 'text', text }), activeCodexBranchId);
        return { queued: true };
    });

    permissionHandler = new CodexPermissionHandler(session);
    const diffProcessor = new DiffProcessor((message) => {
        const envelopes = mapCodexProcessorMessageToSessionEnvelopes(message, { currentTurnId });
        for (const envelope of envelopes) {
            session.sendSessionProtocolMessage(envelope, activeCodexBranchId);
        }
    });

    // Approval handler: routes server → client approval requests to our permission handler
    const approvalHandler: import('./codexAppServerClient').ApprovalHandler = async (params) => {
        const toolName = params.type === 'exec'
            ? 'CodexBash'
            : params.type === 'patch'
                ? 'CodexPatch'
                : (params.toolName ?? 'McpTool');
        const input = params.type === 'exec'
            ? { command: params.command, cwd: params.cwd }
            : params.type === 'patch'
                ? { changes: params.fileChanges }
                : (params.input ?? {});

        try {
            const result = await permissionHandler.handleToolCall(params.callId, toolName, input, params.protocol);
            logger.debug('[Codex] Permission result:', result.decision);
            return result.decision;
        } catch (error) {
            logger.debug('[Codex] Error handling permission:', error);
            return 'denied';
        }
    };
    client.setApprovalHandler(approvalHandler);

    const userInputHandler: import('./codexAppServerClient').UserInputHandler = async (params) => {
        const uiQuestions = (Array.isArray(params.questions) ? params.questions : []).map((question) => ({
            id: question.id,
            header: question.header,
            question: question.question,
            options: question.options ?? [],
            multiSelect: question.multiSelect ?? false,
            isOther: question.isOther,
            isSecret: question.isSecret,
            required: question.required ?? true,
        }));
        try {
            const result = await permissionHandler.handleToolCall(
                params.itemId,
                'AskUserQuestion',
                { questions: uiQuestions, answerFormat: 'codex', autoResolutionMs: params.autoResolutionMs },
                params.protocol,
            );
            if (result.decision !== 'approved' && result.decision !== 'approved_for_session') {
                return { answers: {}, cancelled: true };
            }
            const answers = result.updatedInput?.answers;
            return answers && typeof answers === 'object'
                ? { answers: answers as Record<string, { answers: string[] }> }
                : { answers: {} };
        } catch (error) {
            logger.warn('[Codex] requestUserInput failed:', error);
            return { answers: {} };
        }
    };
    client.setUserInputHandler(userInputHandler);
    sideChats = new CodexSideChats({
        file: join(configuration.haplaHomeDir, 'codex-sides', `${session.getMetadata()?.conversationRootSessionId ?? session.sessionId}.json`),
        sourceThread: () => client.threadId,
        sourceContext: async () => {
            if (!client.turnId) return null;
            let partial: unknown[] = [];
            try {
                const turn = (await client.readThreadTurns()).find(turn => turn.id === client.turnId);
                partial = turn?.items?.filter((item: any) => item.type === 'userMessage' || item.type === 'agentMessage') ?? [];
            } catch { /* The accepted local input still supplies context during a read race. */ }
            return JSON.stringify({ acceptedInput: mainTurnInputText, partial });
        },
        createClient: () => new CodexAppServerClient(sandboxConfig, opts.codexArgs ?? []),
        approval: approvalHandler, userInput: userInputHandler,
        observe: (event, threadId) => permissionHandler.observeProtocolEvent(event, threadId),
        abort: threadId => permissionHandler.abortThread(threadId),
        reset: threadId => permissionHandler.resetThread(threadId),
        changed: chats => session.updateAgentState(state => ({ ...state, codexSideChats: chats })),
    });
    session.updateAgentState(state => ({ ...state, codexSideChats: sideChats!.snapshot(), codexInputs: { ...messageQueue.snapshot(), items: messageQueue.snapshot().items.map(({ id, message, revision, createdAt, error }) => ({ id, message, revision, createdAt, error })) } }));
    session.rpcHandlerManager.registerHandler('codex-side-send', async (params: any) => {
        if (typeof params?.id !== 'string' || typeof params?.text !== 'string' || params.text.length > 128 * 1024) throw new Error('无效的旁问');
        await waitForCodexThread();
        const images = Array.isArray(params.images) ? params.images : [];
        if (images.length > 8 || images.some((image: any) => typeof image.url !== 'string' || typeof image.mediaType !== 'string')) throw new Error('无效的旁问图片');
        const input = images.length ? await getCodexInputItemsAsync({ role: 'user', content: { type: 'multimodal', parts: [...images.map((image: any) => ({ type: 'image' as const, source: { type: 'url' as const, url: image.url, media_type: image.mediaType } })), { type: 'text', text: params.text }] } }, { serverUrl: configuration.serverUrl, token: session.authToken }) : undefined;
        return sideChats!.submit({ id: params.id, chatId: params.chatId, text: params.text, input: input as InputItem[] | undefined, configuration: sessionConfigurationValuesSchema.parse(params.configuration ?? {}) });
    });
    session.rpcHandlerManager.registerHandler('codex-side-action', async (params: any) => {
        if (params?.action === 'stop') await sideChats!.stop(params.id);
        else if (params?.action === 'remove') await sideChats!.remove(params.id);
        else throw new Error('未知旁聊操作');
        return { success: true };
    });
    session.rpcHandlerManager.registerHandler('codex-queue', async (params: any) => {
        switch (params?.action) {
            case 'list': break;
            case 'update': {
                if (typeof params.text !== 'string' || !params.text.trim() || params.text.length > 128 * 1024) throw new Error('无效的队列内容');
                const item = messageQueue.get(params.id, params.revision);
                messageQueue.hold(item.id);
                try {
                    await session.sendSessionProtocolMessage(createEnvelope('user', { t: 'text', text: params.text,
                        inputEdit: { messageId: item.mode.sourceMessageId ?? item.id, revision: item.revision + 1 },
                    }), item.mode.branchId ?? activeCodexBranchId);
                    messageQueue.release(item.id);
                    messageQueue.update(params.id, params.revision, params.text);
                } catch (error) { messageQueue.release(item.id); throw error; }
                break;
            }
            case 'remove': messageQueue.remove(params.id, params.revision); break;
            case 'reorder': messageQueue.reorder(params.ids); break;
            case 'pause': messageQueue.pause(); break;
            case 'start': messageQueue.start(params.id); break;
            case 'inject': {
                const item = messageQueue.get(params.id, params.revision);
                if (item.mode.branchId && item.mode.branchId !== activeCodexBranchId) throw new Error('这条排队消息属于其他分支，请切换到对应分支后发送');
                if (client.turnId) {
                    messageQueue.hold(item.id);
                    try {
                        await client.steerTurnContent(item.contentBlocks as InputItem[] ?? [{ type: 'text', text: item.message }], item.id);
                        turnInputs.record(item.mode.sourceMessageId, { threadId: client.threadId!, turnId: client.turnId!, steered: true });
                        mainTurnInputText += `\n${item.message}`;
                        messageQueue.acknowledge(item.id, 'steered');
                    } catch (error) { messageQueue.fail(item.id, error instanceof Error ? error.message : String(error)); throw error; }
                } else messageQueue.start(params.id);
                break;
            }
            default: throw new Error('未知队列操作');
        }
        return messageQueue.snapshot();
    });



    // Event handler: same EventMsg types as the legacy MCP server — no changes needed
    client.setEventHandler((msg) => {
        const protocol = msg.protocol as Record<string, unknown> | undefined;
        const completionItemId = typeof msg.call_id === 'string' ? msg.call_id : typeof msg.item_id === 'string' ? msg.item_id : '';
        const completedCommandContext = msg.type === 'exec_command_end' ? commandOutputs.getContext(completionItemId) : null;
        const knownLateCommandCompletion = !!completedCommandContext && !!protocol
            && completedCommandContext.turnId === protocol.turnId
            && completedCommandContext.threadId === protocol.threadId
            && completedCommandContext.epoch === protocol.epoch;
        const messageBranchId = knownLateCommandCompletion ? completedCommandContext!.branchId ?? activeCodexBranchId : activeCodexBranchId;
        // Late events from a prior runtime, turn or branch must not mutate the current stream/UI.
        if (codexRuntime && protocol && msg.type !== 'codex_runtime_started') {
            if (protocol.epoch !== codexRuntime.epoch) return;
            if (typeof protocol.seq === 'number' && protocol.seq <= lastProtocolSequence) return;
            if (typeof protocol.threadId === 'string' && codexRuntime.threadId
                && protocol.threadId !== codexRuntime.threadId && msg.type !== 'codex_thread_status') return;
            if (typeof protocol.turnId === 'string' && currentTurnId
                && protocol.turnId !== currentTurnId && msg.type !== 'task_started' && !knownLateCommandCompletion) return;
            if (msg.type === 'exec_command_end' && protocol.turnId !== currentTurnId && !knownLateCommandCompletion) return;
        }
        if (msg.type === 'token_count') {
            const last = msg.last as { totalTokens?: number } | undefined;
            const used = last?.totalTokens; const capacity = msg.modelContextWindow;
            if (typeof used === 'number' && Number.isFinite(used) && used >= 0) void session.updateMetadata(metadata => ({ ...metadata,
                contextUsage: { usedTokens: used, contextWindow: typeof capacity === 'number' && capacity > 0 ? capacity : null, model: submittedModel ?? metadata.currentModelCode, threadId: client.threadId ?? undefined },
            }));
        }
        const nextRuntime = reduceCodexRuntimeEvent(codexRuntime, msg);
        if (msg.type === 'codex_runtime_started' && nextRuntime === codexRuntime) return;
        permissionHandler.observeProtocolEvent(msg, client.threadId ?? undefined);
        if (msg.type === 'codex_runtime_started' || msg.type === 'codex_thread_status') turnBarrier.recovered();
        if (nextRuntime !== codexRuntime) {
            codexRuntime = nextRuntime;
            if (msg.type === 'codex_runtime_started') {
                if (currentTurnId) sessionStreams.flushTurn(currentTurnId);
                currentTurnId = null;
                codexStartedSubagents.clear();
                codexActiveSubagents.clear();
                codexProviderSubagentToSessionSubagent.clear();
                commandOutputs.dispose();
                reasoningSummaryParts.clear();
                lastProtocolSequence = -1;
            }
            if (nextRuntime) {
                thinking = isCodexTurnRunning(nextRuntime) || nextRuntime.runtime === 'active';
                currentActivity = nextRuntime.activity;
                session.updateAgentState((state) => ({ ...state, codexRuntime: nextRuntime }));
                session.keepAlive(thinking, 'remote', currentActivity);
            }
        }
        if (typeof protocol?.seq === 'number') lastProtocolSequence = protocol.seq;
        if (codexRuntime && !isCodexTurnRunning(codexRuntime)
            && (msg.type === 'exec_command_begin' || msg.type === 'exec_command_output_delta')) {
            // Late tool bytes after an authoritative terminal turn must not reopen a released command log.
            return;
        }
        logger.debug(`[Codex] Event: ${JSON.stringify(msg)}`);

        if ((msg.type === 'mcp_tool_call_begin' || msg.type === 'mcp_tool_call_end')
            && typeof msg.server === 'string'
            && typeof msg.tool === 'string'
            && typeof msg.resource_uri === 'string') {
            interactiveAppScopes.set(msg.resource_uri, {
                server: msg.server,
                sourceTool: msg.tool,
                resourceUri: msg.resource_uri,
                lastSeenAt: Date.now(),
                callTimestamps: interactiveAppScopes.get(msg.resource_uri)?.callTimestamps ?? [],
            });
        }

        let acknowledgeStream: (() => void) | undefined;
        const itemId = typeof msg.item_id === 'string' ? msg.item_id
            : typeof msg.call_id === 'string' ? msg.call_id : '';
        if (msg.type === 'exec_command_begin' && itemId) {
            commandOutputs.begin(itemId, { ...msg, turn_id: currentTurnId, branchId: activeCodexBranchId });
        } else if (msg.type === 'exec_command_output_delta' && itemId && typeof msg.delta === 'string') {
            const preview = commandOutputs.append(itemId, msg.delta, { turn_id: currentTurnId, protocol: msg.protocol, branchId: activeCodexBranchId });
            if (currentTurnId) {
                sessionStreams.update({
                    id: itemId, callId: itemId, turnId: currentTurnId,
                    branchId: activeCodexBranchId, kind: 'tool-output', text: preview.output,
                    epoch: codexRuntime?.epoch,
                    truncated: preview.truncated, totalBytes: preview.totalBytes,
                });
            }
        } else if (msg.type === 'exec_command_end' && itemId) {
            msg = { ...commandOutputs.complete(itemId, msg), type: msg.type, protocol: msg.protocol };
            acknowledgeStream = sessionStreams.finish(itemId, typeof msg.output === 'string' ? msg.output : undefined);
        }

        // Add messages to the ink UI buffer based on message type.
        if (msg.type === 'agent_message_delta') {
            const delta = typeof msg.delta === 'string' ? msg.delta : '';
            if (itemId && delta && currentTurnId) {
                sessionStreams.append({ id: itemId, turnId: currentTurnId, branchId: activeCodexBranchId, epoch: codexRuntime?.epoch }, delta);
                messageBuffer.updateLastMessage(delta, 'assistant');
            }
        } else if (msg.type === 'agent_message') {
            const messageText = typeof msg.message === 'string' ? msg.message : '';
            acknowledgeStream = sessionStreams.finish(itemId, messageText);
            messageBuffer.addMessage(messageText, 'assistant');
        } else if ((msg.type === 'agent_reasoning_delta' || msg.type === 'agent_reasoning_section_break')
            && msg.summary === true && itemId && currentTurnId) {
            const parts = reasoningSummaryParts.get(itemId) ?? new Map<number, string>();
            const index = typeof msg.summary_index === 'number' && Number.isSafeInteger(msg.summary_index) ? msg.summary_index : 0;
            parts.set(index, (parts.get(index) ?? '') + (msg.type === 'agent_reasoning_delta' && typeof msg.delta === 'string' ? msg.delta : ''));
            reasoningSummaryParts.set(itemId, parts);
            const text = [...parts.entries()].sort(([left], [right]) => left - right).map(([, text]) => text).join('\n\n');
            sessionStreams.update({ id: itemId, turnId: currentTurnId, branchId: activeCodexBranchId, epoch: codexRuntime?.epoch, kind: 'reasoning-summary', text });
        } else if (msg.type === 'agent_reasoning') {
            reasoningSummaryParts.delete(itemId);
            if (msg.summary === true && typeof msg.text === 'string') {
                acknowledgeStream = sessionStreams.finish(itemId, msg.text);
            }
        } else if (msg.type === 'exec_command_begin') {
            messageBuffer.addMessage(`Executing: ${(msg as any).command}`, 'tool');
        } else if (msg.type === 'exec_command_end') {
            const output = (msg as any).output || (msg as any).error || 'Command completed';
            const truncatedOutput = output.substring(0, 200);
            messageBuffer.addMessage(
                `Result: ${truncatedOutput}${output.length > 200 ? '...' : ''}`,
                'result'
            );
        } else if (msg.type === 'task_started') {
            messageBuffer.addMessage('Starting task...', 'status');
        } else if (msg.type === 'task_complete') {
            // Ready is emitted from the main loop's idle check so pushes only fire once
            // after the queue is actually drained.
            messageBuffer.addMessage('Task completed', 'status');
        } else if (msg.type === 'turn_aborted') {
            messageBuffer.addMessage('Turn aborted', 'status');
        }

        if (msg.type === 'turn_aborted' || (msg.type === 'task_complete' && msg.status === 'failed')) {
            turnMediaDelivery?.cancel();
        } else {
            const mediaTurnId = typeof protocol?.turnId === 'string' ? protocol.turnId : currentTurnId;
            if (mediaTurnId && mediaTurnId === currentTurnId) {
                const step = artifactStep(mediaTurnId, itemId || undefined, messageBranchId,
                    typeof protocol?.at === 'number' ? protocol.at : Date.now());
                if (msg.type === 'generated_image' && typeof msg.path === 'string'
                    && (msg.status === 'completed' || msg.status === undefined)) {
                    turnMediaDelivery?.request(step, [msg.path]);
                } else if (isCompletedArtifactStep(msg)) turnMediaDelivery?.request(step);
            }
        }

        if (!codexRuntime && msg.type === 'task_started') {
            if (!thinking) {
                logger.debug('thinking started');
                thinking = true;
                session.keepAlive(thinking, 'remote', currentActivity);
            }
        }
        if (msg.type === 'task_complete' || msg.type === 'turn_aborted') {
            // Publish any throttled tail without removing visible provisional content.
            // Only acknowledgement of its own durable item may release a stream.
            if (currentTurnId) sessionStreams.flushTurn(currentTurnId);
            if (!codexRuntime && thinking) {
                logger.debug('thinking completed');
                thinking = false;
                session.keepAlive(thinking, 'remote', currentActivity);
            }
            // Reset diff processor on task end or abort
            diffProcessor.reset();
        }
        if (!codexRuntime) {
            if (msg.type === 'task_started') {
                publishActivity({ phase: 'starting' });
            } else if (msg.type === 'task_complete' || msg.type === 'turn_aborted') {
                publishActivity(null);
            } else if (msg.type === 'codex_activity' && typeof (msg as any).phase === 'string') {
                // Activity presence is intentionally metadata-only. Command text and
                // paths remain inside the encrypted message stream; the web client
                // can enrich the label from the already-decrypted running tool.
                publishActivity({
                    phase: (msg as any).phase,
                    ...(typeof (msg as any).itemType === 'string' ? { itemType: (msg as any).itemType } : {}),
                });
            } else if (msg.type === 'agent_message_delta') {
                publishActivity({ phase: 'outputting', itemType: 'agentMessage' });
            } else if (msg.type === 'agent_reasoning_delta' || msg.type === 'agent_reasoning_section_break') {
                publishActivity({ phase: 'reasoning', itemType: 'reasoning' });
            }
        }
        if (msg.type === 'patch_apply_begin') {
            const { changes } = msg as any;
            const changeCount = Object.keys(changes).length;
            const filesMsg = changeCount === 1 ? '1 file' : `${changeCount} files`;
            messageBuffer.addMessage(`Modifying ${filesMsg}...`, 'tool');
        }
        if (msg.type === 'patch_apply_end') {
            const { stdout, stderr, success } = msg as any;
            if (success) {
                const message = stdout || 'Files modified successfully';
                messageBuffer.addMessage(message.substring(0, 200), 'result');
            } else {
                const errorMsg = stderr || 'Failed to modify files';
                messageBuffer.addMessage(`Error: ${errorMsg.substring(0, 200)}`, 'result');
            }
        }
        if (msg.type === 'turn_diff') {
            if ((msg as any).unified_diff) {
                diffProcessor.processDiff((msg as any).unified_diff);
            }
        }

        // Convert events into the unified session-protocol envelope stream.
        // Reasoning deltas are handled by ReasoningProcessor to avoid duplicate text output.
        if (msg.type !== 'exec_command_output_delta' && msg.type !== 'agent_message_delta' && msg.type !== 'agent_reasoning_delta' && msg.type !== 'agent_reasoning_section_break' && msg.type !== 'turn_diff') {
            const terminalTurnId = typeof protocol?.turnId === 'string' ? protocol.turnId
                : typeof msg.turn_id === 'string' ? msg.turn_id : null;
            if (currentTurnId && terminalTurnId === currentTurnId
                && (msg.type === 'turn_aborted' || (msg.type === 'task_complete' && msg.status === 'failed'))) {
                // turn/completed is authoritative even if no individual command completion follows.
                // Persist received output and release the command's file/ring before the turn boundary.
                const status = msg.status === 'failed' ? 'failed' : 'interrupted';
                const confirmedItemIds = new Set<string>(msg.commands_confirmed === true && Array.isArray(msg.cleanup_item_ids)
                    ? msg.cleanup_item_ids.filter((id): id is string => typeof id === 'string') : []);
                for (const command of commandOutputs.finishTurn(currentTurnId, status, confirmedItemIds)) {
                    const callId = command.call_id as string;
                    const acknowledged = sessionStreams.finish(callId, command.output as string);
                    const completed = mapCodexMcpMessageToSessionEnvelopes(command, {
                        currentTurnId,
                        startedSubagents: codexStartedSubagents,
                        activeSubagents: codexActiveSubagents,
                        providerSubagentToSessionSubagent: codexProviderSubagentToSessionSubagent,
                    });
                    for (const envelope of completed.envelopes) {
                        const receipt = session.sendSessionProtocolMessage(envelope, activeCodexBranchId);
                        if (envelope.ev.t === 'tool-call-end') {
                            void receipt.then(acknowledged).catch((error) => {
                                logger.warn('[Codex] Interrupted command not acknowledged; retaining its stream', error);
                            });
                        }
                    }
                }
            }
            if (msg.type === 'task_complete' || msg.type === 'turn_aborted') {
                lastCompletedTurnId = currentTurnId;
            }
            const mapped = mapCodexMcpMessageToSessionEnvelopes(msg, {
                currentTurnId,
                startedSubagents: codexStartedSubagents,
                activeSubagents: codexActiveSubagents,
                providerSubagentToSessionSubagent: codexProviderSubagentToSessionSubagent,
            });
            currentTurnId = mapped.currentTurnId;
            if (msg.type === 'task_started') {
                lastCompletedTurnId = null;
                if (currentTurnId && client.threadId) turnInputs.record(activeSourceMessageId, { threadId: client.threadId, turnId: currentTurnId });
            }
            codexStartedSubagents = mapped.startedSubagents;
            codexActiveSubagents = mapped.activeSubagents;
            codexProviderSubagentToSessionSubagent = mapped.providerSubagentToSessionSubagent;
            for (const envelope of mapped.envelopes) {
                const persisted = session.sendSessionProtocolMessage(envelope, messageBranchId);
                if (acknowledgeStream && (
                    (envelope.ev.t === 'text' && envelope.id === itemId)
                    || (envelope.ev.t === 'tool-call-end' && envelope.ev.call === itemId)
                )) {
                    void persisted.then(acknowledgeStream).catch((error) => {
                        logger.warn('[Codex] Final message not acknowledged; retaining its stream', error);
                    });
                }
            }
        }
    });

    // Start Hapla MCP server (HTTP) and prepare STDIO bridge config for Codex
    const haplaServer = await startHaplaServer(session);
    // Launch the bridge via `node <path>` (rather than relying on the .mjs shebang)
    // so it works on Windows, where Windows can't execute shebang scripts directly.
    // codex would otherwise fail to start the MCP server, the change_title tool would
    // not be visible to the model, and the model would improvise with shell echoes.
    const bridgeEntrypoint = join(projectPath(), 'dist', 'codex', 'haplaMcpStdioBridge.mjs');
    const mcpServers: Record<string, unknown> = {
        hapla: {
            command: process.execPath,
            args: ['--no-warnings', '--no-deprecation', bridgeEntrypoint, '--url', haplaServer.url]
        }
    };
    let first = true;

    try {
        await runCodexStartup({
            initialize: async () => {
                logger.debug('[codex]: client.connect begin');
                await client.connect();
                logger.debug('[codex]: client.connect done');

                await client.setSkillExtraRoots([join(projectPath(), 'skills')]).catch((error) => {
                    logger.warn('[Codex] Installed app-server does not accept Hapla built-in Skill roots:', error);
                });

                const visibleSkills = await client.listSkills(process.cwd(), true).catch((error) => {
                    logger.warn('[Codex] Failed to discover interactive Skills:', error);
                    return [];
                });
                const interactiveDiscovery = await discoverInteractiveSkillServers(visibleSkills);
                for (const [serverName, interactive] of Object.entries(interactiveDiscovery.servers)) {
                    mcpServers[serverName] = interactive.config;
                }
                for (const error of interactiveDiscovery.errors) {
                    logger.warn(`[Codex] Interactive Skill skipped: ${error}`);
                }
                if (Object.keys(interactiveDiscovery.servers).length > 0) {
                    logger.info(`[Codex] Loaded ${Object.keys(interactiveDiscovery.servers).length} interactive Skill service(s).`);
                }

                const models = await client.listModels().catch((error) => {
                    logger.debug('[Codex] Failed to read model catalog for session metadata:', error);
                    return [];
                });
                if (models.length > 0) {
                    session.updateMetadata((currentMetadata) => ({
                        ...currentMetadata,
                        models: mapCodexModelsToMetadata(models),
                    }));
                }

                if (opts.resumeThreadId) {
                    const resumed = await resumeExistingThread({
                        client,
                        session,
                        messageBuffer,
                        threadId: opts.resumeThreadId,
                        cwd: process.cwd(),
                        mcpServers,
                    });
                    activeCodexBranchId = session.getMetadata()?.activeCodexBranchId ?? resumed.threadId;
                    session.updateMetadata((metadata) => ({
                        ...metadata,
                        activeCodexBranchId,
                        codexBranches: metadata.codexBranches ?? [{
                            id: activeCodexBranchId,
                            threadId: resumed.threadId,
                            label: 'Original',
                            createdAt: Date.now(),
                        }],
                    }));
                    first = false;
                }
            },
            acknowledge: async () => {
                if (!response) return;
                const readyMetadata = session.getMetadata() ?? metadata;
                logger.debug(`[START] Reporting ready session ${session.sessionId} to daemon`);
                const result = await notifyDaemonSessionStarted(session.sessionId, readyMetadata);
                if (result.error) {
                    if (opts.startedBy === 'daemon') throw new Error(`Daemon readiness acknowledgement failed: ${result.error}`);
                    logger.debug('[START] Daemon is unavailable for this terminal session:', result.error);
                    return;
                }
                logger.debug(`[START] Reported ready session ${session.sessionId} to daemon`);
            },
            reportFailure: (error) => {
                // Keep the provider's actual reason (for example an existing
                // active writer), instead of silently closing a success-ACKed session.
                logger.warn('[Codex] Startup failed:', error.message);
                session.sendSessionEvent({ type: 'message', message: `Codex startup failed: ${error.message}` });
            },
        });

        let pending: {
            id?: string;
            message: string;
            contentBlocks?: import('@/utils/MessageQueue2').ContentBlock[];
            mode: EnhancedMode;
            isolate: boolean;
            hash: string;
        } | null = null;

        while (!shouldExit) {
            if (!await sleepBarrier.waitForTurn()) break;
            if (!await turnBarrier.wait()) break;
            logActiveHandles('loop-top');
            let message: {
                id?: string;
                message: string;
                contentBlocks?: import('@/utils/MessageQueue2').ContentBlock[];
                mode: EnhancedMode;
                isolate: boolean;
                hash: string;
            } | null = pending;
            pending = null;
            if (!message) {
                // Capture the current signal to distinguish idle-abort from queue close
                const waitSignal = abortController.signal;
                const batch = await messageQueue.waitForMessagesAndGetAsString(waitSignal);
                if (!batch) {
                    // If wait was aborted (e.g., remote abort with no active inference), ignore and continue
                    if (waitSignal.aborted && !shouldExit) {
                        logger.debug('[codex]: Wait aborted while idle; ignoring and continuing');
                        continue;
                    }
                    logger.debug(`[codex]: batch=${!!batch}, shouldExit=${shouldExit}`);
                    break;
                }
                message = batch;
            }

            // Defensive check for TS narrowing
            if (!message) {
                break;
            }
            await codingCheckpoints.waitForRestore();
            hasUnsubmittedInput = true;
            if (!await sleepBarrier.waitForTurn()) break;
            if (!await turnBarrier.wait()) break;

            let turnCheckpoint: import('@hapla/wire').GitCheckpoint | null = null;
            // Display user messages in the UI
            messageBuffer.addMessage(message.message, 'user');

            try {
                if (message.mode.branchId && client.threadId && message.mode.branchId !== activeCodexBranchId) {
                    throw new Error('这条排队消息属于其他分支，请切换到对应分支后重试');
                }
                // Map permission mode to approval policy and sandbox.
                // With app-server, these are per-turn — no restart needed on mode change.
                const sandboxManagedByHapla = client.sandboxEnabled;
                const executionPolicy = resolveCodexExecutionPolicy(
                    message.mode.permissionMode,
                    sandboxManagedByHapla,
                );
                const shouldAutoDisplayGeneratedImages = shouldAppendGeneratedImageDisplayInstruction(message.message);

                // Start thread on first turn (thread persists across mode changes)
                if (!client.hasActiveThread()) {
                    const startedThread = await client.startThread({
                        model: message.mode.model ?? undefined,
                        verbosity: message.mode.verbosity,
                        cwd: process.cwd(),
                        approvalPolicy: executionPolicy.approvalPolicy,
                        sandbox: executionPolicy.sandbox,
                        mcpServers,
                    });
                    activeCodexBranchId = startedThread.threadId;
                    session.updateMetadata((currentMetadata) => ({
                        ...currentMetadata,
                        codexThreadId: startedThread.threadId,
                        activeCodexBranchId: startedThread.threadId,
                        codexBranches: currentMetadata.codexBranches ?? [{
                            id: startedThread.threadId,
                            threadId: startedThread.threadId,
                            label: 'Original',
                            createdAt: Date.now(),
                        }],
                        currentModelCode: startedThread.model,
                    }));
                }

                const mediaOptions = { workspaceRoot: process.cwd(), threadId: client.threadId };
                const turnMediaBaseline = await captureTurnMediaBaseline({
                    workspaceRoot: process.cwd(),
                    threadId: client.threadId,
                }).catch((error) => {
                    logger.warn('[Codex] Failed to capture the turn media baseline', error);
                    return null;
                });
                if (turnMediaBaseline) {
                    const generatedRoot = mediaOptions.threadId ? join(GENERATED_MEDIA_ROOT, mediaOptions.threadId) : null;
                    const allowedRoots = [mediaOptions.workspaceRoot, ...(generatedRoot ? [generatedRoot] : [])];
                    const resolvedGeneratedRoot = generatedRoot ? await mediaRealpath(generatedRoot).catch(() => generatedRoot) : null;
                    turnMediaDelivery = new TurnArtifactDelivery({
                        ledger: artifactLedger,
                        scan: (hints, signal, step) => discoverTurnMediaCandidates(turnMediaBaseline, { ...mediaOptions, modifiedBefore: step.time }, hints, signal),
                        onError: error => logger.warn('[Codex] Could not deliver a generated artifact; a later completed step may retry', error),
                        deliver: async (candidate, step, signal) => {
                            const artifact = await prepareGeneratedMediaArtifact(candidate, {
                                serverUrl: configuration.serverUrl, token: session.authToken,
                            }, allowedRoots, resolvedGeneratedRoot, signal);
                            if (!artifact) return false;
                            signal.throwIfAborted();
                            const receipt = session.sendSessionProtocolMessage(createEnvelope('agent', {
                                t: 'file', ...artifact,
                                artifact: { origin: 'automatic', batchId: step.batchId, sourceId: step.sourceId, path: candidate.path },
                            }, { turn: step.turnId, time: step.time }), step.branchId);
                            // The session outbox owns retransmission from this
                            // point. Waiting for its ACK must not occupy a media
                            // worker or prevent the remaining files being queued.
                            return { receipt };
                        },
                    });
                } else turnMediaDelivery = null;

                const generatedMediaInstruction = shouldAutoDisplayGeneratedImages ? GENERATED_MEDIA_DISPLAY_INSTRUCTION : '';
                const turnPrompt = first
                    ? message.message + '\n\n' + CHANGE_TITLE_INSTRUCTION + generatedMediaInstruction
                    : message.message + generatedMediaInstruction;
                const contentBlocks = message.contentBlocks
                    ? (
                        first
                            ? [...message.contentBlocks, { type: 'text', text: CHANGE_TITLE_INSTRUCTION + generatedMediaInstruction }]
                            : (
                                generatedMediaInstruction
                                    ? [...message.contentBlocks, { type: 'text', text: generatedMediaInstruction }]
                                    : message.contentBlocks
                            )
                    ) as import('./codexAppServerTypes').InputItem[]
                    : null;

                // Media preparation can yield to a provider compaction. Keep
                // this exact batch here until its authoritative terminal event.
                if (!await turnBarrier.wait()) break;
                if (codingCheckpoints.isRestoring()) throw new Error('Workspace restore is in progress.');
                turnCheckpoint = await codingCheckpoints.begin(message.message, { forkMessageId: message.mode.sourceMessageId, forkMessageCreatedAt: message.mode.sourceMessageCreatedAt }).catch(error => {
                    session.sendSessionEvent({ type: 'message', message: `Checkpoint unavailable: ${error instanceof Error ? error.message : String(error)}` }); return null;
                });
                hasUnsubmittedInput = false;
                mainTurnInputText = message.message;
                activeSourceMessageId = message.mode.sourceMessageId;
                submittedModel = message.mode.model ?? session.getMetadata()?.currentModelCode;
                const result = contentBlocks
                    ? await client.sendTurnContentAndWait(
                        contentBlocks,
                        {
                            model: message.mode.model,
                            effort: message.mode.effort,
                            verbosity: message.mode.verbosity, serviceTier: message.mode.serviceTier, collaborationMode: message.mode.collaborationMode,
                            approvalPolicy: executionPolicy.approvalPolicy,
                            sandbox: executionPolicy.sandbox,
                            networkAccess: shouldAutoDisplayGeneratedImages,
                        },
                    )
                    : await client.sendTurnAndWait(turnPrompt, {
                        model: message.mode.model,
                        effort: message.mode.effort,
                        verbosity: message.mode.verbosity, serviceTier: message.mode.serviceTier, collaborationMode: message.mode.collaborationMode,
                        approvalPolicy: executionPolicy.approvalPolicy,
                        sandbox: executionPolicy.sandbox,
                        networkAccess: shouldAutoDisplayGeneratedImages,
                    });
                if (turnCheckpoint) await codingCheckpoints.finish(turnCheckpoint.id, currentTurnId ?? lastCompletedTurnId ?? undefined, result.aborted ? 'interrupted' : 'complete')
                    .catch(error => session.sendSessionEvent({ type: 'message', message: `Checkpoint finalization failed: ${String(error)}` }));
                turnCheckpoint = null;
                if (message.id) messageQueue.acknowledge(message.id, result.aborted ? 'interrupted' : 'completed');
                const completedMediaTurnId = currentTurnId ?? lastCompletedTurnId;
                if (!result.aborted && completedMediaTurnId) {
                    await turnMediaDelivery?.finish(artifactStep(completedMediaTurnId));
                } else turnMediaDelivery?.cancel();
                if (!result.aborted && message.mode.model) {
                    session.updateMetadata((currentMetadata) => ({
                        ...currentMetadata,
                        currentModelCode: message.mode.model ?? undefined,
                    }));
                }
                first = false;

                if (result.aborted) {
                    // Turn was aborted (user abort or permission cancel).
                    // UI handling already done by the event handler (turn_aborted).
                    logger.debug('[Codex] Turn aborted');
                }
            } catch (error) {
                if (message.id) messageQueue.fail(message.id, error instanceof Error ? error.message : String(error));
                logger.warn('Error in codex session:', error);
                let failureMessage = `Codex execution failed: ${error instanceof Error ? error.message : String(error)}`;
                let recoveryMessage: string | null = null;
                if (error instanceof CodexTurnFailure && error.recovery === 'restored') {
                    recoveryMessage = 'The original conversation was restored automatically. Send another message to continue.';
                } else if (error instanceof CodexTurnFailure && error.recovery === 'failed') {
                    recoveryMessage = `Automatic conversation recovery failed: ${error.recoveryError}. The conversation history is preserved.`;
                }
                if (recoveryMessage) failureMessage += `\n${recoveryMessage}`;
                messageBuffer.addMessage(failureMessage, 'status');
                if (!(error instanceof CodexTurnFailure)) {
                    session.sendSessionEvent({ type: 'message', message: failureMessage });
                } else if (recoveryMessage) {
                    // The mapper already persisted the failed turn's reason.
                    // Report recovery separately without repeating that failure.
                    session.sendSessionEvent({ type: 'message', message: recoveryMessage });
                }
            } finally {
                if (turnCheckpoint) await codingCheckpoints.finish(turnCheckpoint.id, currentTurnId ?? lastCompletedTurnId ?? undefined, 'failed').catch(error => logger.warn('[Codex] Checkpoint finalization failed', error));
                turnMediaDelivery?.cancel();
                turnMediaDelivery = null;
                hasUnsubmittedInput = false;
                // Reset permission handler, reasoning processor, and diff processor
                permissionHandler.resetThread(client.threadId);
                reasoningSummaryParts.clear();
                diffProcessor.reset();
                // A transport failure or interrupt acknowledgement is not a completed turn.
                const settledRuntime = getCodexRuntime();
                thinking = settledRuntime ? isCodexTurnRunning(settledRuntime) || settledRuntime.runtime === 'active' : false;
                currentActivity = settledRuntime?.activity ?? null;
                session.keepAlive(thinking, 'remote', currentActivity);
                if (!thinking && (!settledRuntime || settledRuntime.runtime === 'idle')) emitReadyIfIdle({
                    pending,
                    queueSize: () => messageQueue.size(),
                    shouldExit,
                    sendReady,
                });
                logActiveHandles('after-turn');
            }
        }

    } finally {
        // Clean up resources when main loop exits
        logger.debug('[codex]: Final cleanup start');
        messageQueue.close();
        await sideChats?.close();
        turnMediaDelivery?.cancel();
        cancelArtifactRecovery();
        session.off?.('connected', resumeArtifactBacklog);
        turnBarrier.close();
        sessionStreams.dispose();
        commandOutputs.dispose();
        logActiveHandles('cleanup-start');

        // Cancel offline reconnection if still running
        if (reconnectionHandle) {
            logger.debug('[codex]: Cancelling offline reconnection');
            reconnectionHandle.cancel();
        }

        try {
            logger.debug('[codex]: sendSessionDeath');
            session.sendSessionDeath();
            logger.debug('[codex]: flush begin');
            await session.flush();
            logger.debug('[codex]: flush done');
            logger.debug('[codex]: session.close begin');
            await session.close();
            logger.debug('[codex]: session.close done');
        } catch (e) {
            logger.debug('[codex]: Error while closing session', e);
        }
        logger.debug('[codex]: client.disconnect begin');
        await client.disconnect();
        logger.debug('[codex]: client.disconnect done');
        // Stop Hapla MCP server
        logger.debug('[codex]: haplaServer.stop');
        haplaServer.stop();

        // Clean up ink UI
        if (process.stdin.isTTY) {
            logger.debug('[codex]: setRawMode(false)');
            try { process.stdin.setRawMode(false); } catch { }
        }
        // Stop reading from stdin so the process can exit
        if (hasTTY) {
            logger.debug('[codex]: stdin.pause()');
            try { process.stdin.pause(); } catch { }
        }
        // Clear periodic keep-alive to avoid keeping event loop alive
        logger.debug('[codex]: clearInterval(keepAlive)');
        clearInterval(keepAliveInterval);
        if (inkInstance) {
            logger.debug('[codex]: inkInstance.unmount()');
            inkInstance.unmount();
        }
        messageBuffer.clear();

        logActiveHandles('cleanup-end');
        logger.debug('[codex]: Final cleanup completed');
    }

    // A remote Codex runtime intentionally goes to sleep after the queue is
    // closed. Do not rely on Node's event-loop becoming empty here: provider
    // transports and RPC libraries may retain internal handles after their
    // public close methods resolve. A lingering wrapper PID makes the daemon
    // believe the runtime is still usable and causes resumed messages to be
    // queued into a dead session. The daemon owns this child and will remove it
    // from its live-runtime registry when the process exits.
    if (shouldExit) {
        logger.debug('[codex]: Runtime is sleeping; exiting wrapper process');
        process.exit(0);
    }
}
