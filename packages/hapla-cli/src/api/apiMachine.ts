import { connectPreviewTunnel } from './previewTunnel';
/**
 * WebSocket client for machine/daemon communication with the Hapla server
 * Similar to ApiSessionClient but for machine-scoped connections
 */

import { io, Socket } from 'socket.io-client';
import { logger } from '@/ui/logger';
import { configuration, resolveMachineWorkspaceRoot } from '@/configuration';
import { MachineMetadata, DaemonState, Machine, Metadata, Update, UpdateMachineBody } from './types';
import { registerCommonHandlers, SpawnSessionOptions, SpawnSessionResult } from '../modules/common/registerCommonHandlers';
import { registerCloudFileHandlers } from '../modules/common/registerCloudFileHandlers';
import { browseMachineDirectory } from '../modules/common/browseMachineDirectory';
import { createCodexUpdater, type CodexUpdateController } from '../codex/codexUpdater';
import { encodeBase64, decodeBase64, encrypt, decrypt } from './encryption';
import { backoff } from '@/utils/time';
import { RpcHandlerManager } from './rpc/RpcHandlerManager';
import { detectCLIAvailability, CLIAvailability } from '@/utils/detectCLI';
import { detectResumeSupport, type ResumeSupport } from '@/resume/localHaplaAgentAuth';
import { shouldReconnect } from '@/utils/lidState';
import { detectCodexVersion, discoverCodexCapabilities } from '@/codex/modelDiscovery';
import { detectClaudeVersion, discoverClaudeCapabilities } from '@/claude/capabilityDiscovery';
import { CodexAppServerClient } from '@/codex/codexAppServerClient';
import { readCliSkill, saveCliSkill, trashCliSkill } from '@/skills/skillFiles';
import { projectPath } from '@/projectPath';
import { join } from 'node:path';
import { homedir } from 'node:os';

interface ServerToDaemonEvents {
    update: (data: Update) => void;
    'rpc-request': (data: { method: string, params: string }, callback: (response: string) => void) => void;
    'rpc-registered': (data: { method: string }) => void;
    'rpc-unregistered': (data: { method: string }) => void;
    'rpc-error': (data: { type: string, error: string }) => void;
    auth: (data: { success: boolean, user: string }) => void;
    error: (data: { message: string }) => void;
}

interface DaemonToServerEvents {
    'machine-alive': (data: {
        machineId: string;
        time: number;
    }) => void;

    'machine-update-metadata': (data: {
        machineId: string;
        metadata: string; // Encrypted MachineMetadata
        expectedVersion: number
    }, cb: (answer: {
        result: 'error'
    } | {
        result: 'version-mismatch'
        version: number,
        metadata: string
    } | {
        result: 'success',
        version: number,
        metadata: string
    }) => void) => void;

    'machine-update-state': (data: {
        machineId: string;
        daemonState: string; // Encrypted DaemonState
        expectedVersion: number
    }, cb: (answer: {
        result: 'error'
    } | {
        result: 'version-mismatch'
        version: number,
        daemonState: string
    } | {
        result: 'success',
        version: number,
        daemonState: string
    }) => void) => void;

    'rpc-register': (data: { method: string }) => void;
    'rpc-unregister': (data: { method: string }) => void;
    'rpc-call': (data: { method: string, params: any }, callback: (response: {
        ok: boolean
        result?: any
        error?: string
    }) => void) => void;
}

type MachineRpcHandlers = {
    spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
    resumeSession?: (request: {
        sessionId: string;
        conversationId: string;
        metadata: Pick<Metadata, 'path' | 'flavor' | 'codexThreadId' | 'claudeSessionId' | 'conversationRootSessionId' | 'codexBranches' | 'activeCodexBranchId'>;
    }) => Promise<SpawnSessionResult>;
    stopSession: (sessionId: string) => boolean;
    requestShutdown: () => void;
    resolveFileWorkspace?: (sessionId: string) => string | undefined;
}

export class ApiMachineClient {
    private socket!: Socket<ServerToDaemonEvents, DaemonToServerEvents>;
    private keepAliveInterval: NodeJS.Timeout | null = null;
    private lastKnownCLIAvailability: CLIAvailability | null = null;
    private lastKnownResumeSupport: ResumeSupport | null = null;
    private lastKnownCodexVersion: string | null | undefined;
    private lastKnownClaudeVersion: string | null | undefined;
    private capabilityRefreshInFlight: Promise<void> | null = null;
    private stopPreviewTunnel: (() => void) | undefined;
    private codexUpdater: CodexUpdateController | null = null;
    private rpcHandlerManager: RpcHandlerManager;
    private readonly workspaceRoot = resolveMachineWorkspaceRoot();
    private resumeSessionHandler: ((request: {
        sessionId: string;
        conversationId: string;
        metadata: Pick<Metadata, 'path' | 'flavor' | 'codexThreadId' | 'claudeSessionId' | 'conversationRootSessionId' | 'codexBranches' | 'activeCodexBranchId'>;
    }) => Promise<SpawnSessionResult>) | null = null;
    private reconnectInterval: NodeJS.Timeout | null = null;

    constructor(
        private token: string,
        private machine: Machine
    ) {
        // Initialize RPC handler manager
        this.rpcHandlerManager = new RpcHandlerManager({
            scopePrefix: this.machine.id,
            encryptionKey: this.machine.encryptionKey,
            encryptionVariant: this.machine.encryptionVariant,
            logger: (msg, data) => logger.debug(msg, data)
        });

        // Machine RPCs remain available when a session exits. Container mounts
        // may live outside the OS home, so allow an explicit operator root.
        registerCommonHandlers(this.rpcHandlerManager, this.workspaceRoot);
        this.rpcHandlerManager.registerHandler('browse-directory', browseMachineDirectory);
    }

    setRPCHandlers({
        spawnSession,
        resumeSession,
        stopSession,
        requestShutdown,
        resolveFileWorkspace
    }: MachineRpcHandlers) {
        registerCloudFileHandlers(this.rpcHandlerManager, this.workspaceRoot, this.token, resolveFileWorkspace);
        this.resumeSessionHandler = resumeSession ?? null;

        const spawnSessionRpcHandler = async (params: any) => {
            const { directory, sessionId, machineId, approvedNewDirectoryCreation, agent, environmentVariables, token } = params || {};
            logger.debug(`[API MACHINE] Spawning session with params: ${JSON.stringify(params)}`);

            if (!directory) {
                throw new Error('Directory is required');
            }

            const result = await spawnSession({ directory, sessionId, machineId, approvedNewDirectoryCreation, agent, environmentVariables, token });

            switch (result.type) {
                case 'success':
                    logger.debug(`[API MACHINE] Spawned session ${result.sessionId}`);
                    return { type: 'success', sessionId: result.sessionId };

                case 'requestToApproveDirectoryCreation':
                    logger.debug(`[API MACHINE] Requesting directory creation approval for: ${result.directory}`);
                    return { type: 'requestToApproveDirectoryCreation', directory: result.directory };

                case 'error':
                    throw new Error(result.errorMessage);
            }
        };
        this.rpcHandlerManager.registerHandler('spawn-hapla-session', spawnSessionRpcHandler);

        this.syncResumeSessionRpcRegistration(detectResumeSupport().rpcAvailable);

        // Register stop session handler  
        this.rpcHandlerManager.registerHandler('stop-session', (params: any) => {
            const { sessionId } = params || {};

            if (!sessionId) {
                throw new Error('Session ID is required');
            }

            const success = stopSession(sessionId);
            if (!success) {
                throw new Error('Session not found or failed to stop');
            }

            logger.debug(`[API MACHINE] Stopped session ${sessionId}`);
            return { message: 'Session stopped' };
        });

        // Register stop daemon handler
        this.rpcHandlerManager.registerHandler('stop-daemon', () => {
            logger.debug('[API MACHINE] Received stop-daemon RPC request');

            // Trigger shutdown callback after a delay
            setTimeout(() => {
                logger.debug('[API MACHINE] Initiating daemon shutdown from RPC');
                requestShutdown();
            }, 100);

            return { message: 'Daemon stop request acknowledged, starting shutdown sequence...' };
        });

        this.rpcHandlerManager.registerHandler('refresh-cli-capabilities', async () => {
            await this.refreshCliCapabilities(true);
            return this.machine.metadata.cliCapabilities ?? null;
        });

        const updater = () => this.codexUpdater ??= createCodexUpdater(() => this.refreshCliCapabilities(true));
        this.rpcHandlerManager.registerHandler('codex-update-status', () => {
            try { return { success: true, status: updater().getStatus() }; }
            catch { return { success: false, error: '无法读取 Codex 更新状态，请检查机器的数据目录权限后重试。' }; }
        });
        this.rpcHandlerManager.registerHandler('codex-update-start', () => {
            try { return { success: true, status: updater().start() }; }
            catch { return { success: false, error: '无法启动 Codex 更新，请检查机器的数据目录权限后重试。' }; }
        });

        this.rpcHandlerManager.registerHandler('set-codex-skill-enabled', async (params: any) => {
            const { name, path, enabled, cwd } = params || {};
            if (typeof name !== 'string' || typeof path !== 'string' || typeof enabled !== 'boolean') {
                throw new Error('Skill name, path and enabled state are required');
            }

            const client = new CodexAppServerClient();
            try {
                await client.connect();
                await client.setSkillExtraRoots([join(projectPath(), 'skills')]);
                const effectiveEnabled = await client.setSkillEnabled({ name, path }, enabled);
                await client.listSkills(typeof cwd === 'string' ? cwd : process.cwd(), true);
                await this.refreshCliCapabilities(true);
                return {
                    effectiveEnabled,
                    skills: this.machine.metadata.cliCapabilities?.codex?.skills ?? [],
                };
            } finally {
                await client.disconnect().catch(() => undefined);
            }
        });

        this.rpcHandlerManager.registerHandler('read-cli-skill', async (params: any) => {
            const { provider, path, cwd } = params || {};
            if (typeof provider !== 'string' || typeof path !== 'string') {
                throw new Error('Skill provider and path are required');
            }
            return readCliSkill({
                provider,
                path,
                cwd: typeof cwd === 'string' ? cwd : process.cwd(),
            });
        });

        this.rpcHandlerManager.registerHandler('save-cli-skill', async (params: any) => {
            const { provider, name, description, source, path, cwd, interactiveManifest } = params || {};
            if (typeof provider !== 'string' || typeof name !== 'string') {
                throw new Error('Skill provider and name are required');
            }
            const result = await saveCliSkill({
                provider,
                name,
                description: typeof description === 'string' ? description : '',
                source: typeof source === 'string' ? source : undefined,
                interactiveManifest: typeof interactiveManifest === 'string' || interactiveManifest === null
                    ? interactiveManifest
                    : undefined,
                path: typeof path === 'string' ? path : null,
                cwd: typeof cwd === 'string' ? cwd : process.cwd(),
            });
            await this.refreshCliCapabilities(true);
            return result;
        });

        this.rpcHandlerManager.registerHandler('trash-cli-skill', async (params: any) => {
            const { provider, path, cwd } = params || {};
            if (typeof provider !== 'string' || typeof path !== 'string') {
                throw new Error('Skill provider and path are required');
            }
            const result = await trashCliSkill({
                provider,
                path,
                cwd: typeof cwd === 'string' ? cwd : process.cwd(),
            });
            await this.refreshCliCapabilities(true);
            return result;
        });
    }

    private syncResumeSessionRpcRegistration(rpcAvailable: boolean): void {
        const methods = ['resume-hapla-session'] as const;

        if (rpcAvailable && this.resumeSessionHandler) {
            const resumeSessionRpcHandler = async (params: any) => {
                    const { sessionId, conversationId, metadata } = params || {};

                    if (!sessionId || typeof sessionId !== 'string') {
                        throw new Error('Session ID is required');
                    }
                    if (!conversationId || typeof conversationId !== 'string') {
                        throw new Error('Conversation ID is required');
                    }
                    if (!metadata || typeof metadata.path !== 'string') {
                        throw new Error('Resumable session metadata is required');
                    }

                    const handler = this.resumeSessionHandler;
                    if (!handler) {
                        throw new Error('Resume session handler not available');
                    }

                    const result = await handler({ sessionId, conversationId, metadata });
                    switch (result.type) {
                        case 'success':
                            return { type: 'success', sessionId: result.sessionId };
                        case 'requestToApproveDirectoryCreation':
                            return result;
                        case 'error':
                            throw new Error(result.errorMessage);
                    }
            };
            for (const method of methods) {
                if (!this.rpcHandlerManager.hasHandler(method)) {
                    this.rpcHandlerManager.registerHandler(method, resumeSessionRpcHandler);
                }
            }
            return;
        }

        for (const method of methods) {
            if (this.rpcHandlerManager.hasHandler(method)) {
                this.rpcHandlerManager.unregisterHandler(method);
            }
        }
    }

    /**
     * Update machine metadata
     * Currently unused, changes from the mobile client are more likely
     * for example to set a custom name.
     */
    async updateMachineMetadata(handler: (metadata: MachineMetadata | null) => MachineMetadata, bounded = false): Promise<void> {
        const update = async () => {
            if (bounded && !this.socket.connected) throw new Error('Machine socket is disconnected');
            const updated = handler(this.machine.metadata);

            const payload = {
                machineId: this.machine.id,
                metadata: encodeBase64(encrypt(this.machine.encryptionKey, this.machine.encryptionVariant, updated)),
                expectedVersion: this.machine.metadataVersion
            };
            const answer = bounded
                ? await this.socket.timeout(5000).emitWithAck('machine-update-metadata', payload)
                : await this.socket.emitWithAck('machine-update-metadata', payload);

            if (answer.result === 'success') {
                this.machine.metadata = decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(answer.metadata));
                this.machine.metadataVersion = answer.version;
                logger.debug('[API MACHINE] Metadata updated successfully');
            } else if (answer.result === 'version-mismatch') {
                if (answer.version > this.machine.metadataVersion) {
                    this.machine.metadataVersion = answer.version;
                    this.machine.metadata = decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(answer.metadata));
                }
                throw new Error('Metadata version mismatch'); // Triggers retry
            } else {
                throw new Error('Machine metadata update rejected');
            }
        };
        if (!bounded) return backoff(update);
        for (let attempt = 0; ; attempt++) {
            try { await update(); return; }
            catch (error) {
                if (attempt >= 2) throw error;
                await new Promise(resolve => setTimeout(resolve, 250));
            }
        }
    }

    /**
     * Update daemon state (runtime info) - similar to session updateAgentState
     * Simplified without lock - relies on backoff for retry
     */
    async updateDaemonState(handler: (state: DaemonState | null) => DaemonState): Promise<void> {
        await backoff(async () => {
            const updated = handler(this.machine.daemonState);

            const answer = await this.socket.emitWithAck('machine-update-state', {
                machineId: this.machine.id,
                daemonState: encodeBase64(encrypt(this.machine.encryptionKey, this.machine.encryptionVariant, updated)),
                expectedVersion: this.machine.daemonStateVersion
            });

            if (answer.result === 'success') {
                this.machine.daemonState = decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(answer.daemonState));
                this.machine.daemonStateVersion = answer.version;
                logger.debug('[API MACHINE] Daemon state updated successfully');
            } else if (answer.result === 'version-mismatch') {
                if (answer.version > this.machine.daemonStateVersion) {
                    this.machine.daemonStateVersion = answer.version;
                    this.machine.daemonState = decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(answer.daemonState));
                }
                throw new Error('Daemon state version mismatch'); // Triggers retry
            }
        });
    }

    connect() {
        this.stopPreviewTunnel?.();
        this.stopPreviewTunnel = connectPreviewTunnel(configuration.serverUrl, this.token, this.machine.id);
        const serverUrl = configuration.serverUrl.replace(/^http/, 'ws');
        logger.debug(`[API MACHINE] Connecting to ${serverUrl}`);

        this.socket = io(serverUrl, {
            transports: ['websocket'],
            auth: {
                token: this.token,
                clientType: 'machine-scoped' as const,
                machineId: this.machine.id,
                haplaClient: `cli-daemon/${configuration.currentCliVersion}`
            },
            path: '/v1/updates',
            reconnection: false,
        });

        this.socket.on('connect', () => {
            logger.debug('[API MACHINE] Connected to server');

            if (this.reconnectInterval) {
                clearInterval(this.reconnectInterval);
                this.reconnectInterval = null;
            }

            this.updateDaemonState((state) => ({
                ...state,
                status: 'running',
                pid: process.pid,
                httpPort: this.machine.daemonState?.httpPort,
                startedAt: Date.now()
            }));

            this.rpcHandlerManager.onSocketConnect(this.socket);
            this.syncResumeSessionRpcRegistration(detectResumeSupport().rpcAvailable);
            this.startKeepAlive();
            void this.refreshCliCapabilities();
        });

        this.socket.on('disconnect', (reason) => {
            logger.debug(`[API MACHINE] Disconnected from server — reason: ${reason}`);
            this.rpcHandlerManager.onSocketDisconnect();
            this.stopKeepAlive();
            this.startSmartReconnect();
        });

        // Single consolidated RPC handler
        this.socket.on('rpc-request', async (data: { method: string, params: string }, callback: (response: string) => void) => {
            logger.debugLargeJson(`[API MACHINE] Received RPC request:`, data);
            callback(await this.rpcHandlerManager.handleRequest(data));
        });

        // Handle update events from server
        this.socket.on('update', (data: Update) => {
            // Machine clients should only care about machine updates
            if (data.body.t === 'update-machine' && (data.body as UpdateMachineBody).machineId === this.machine.id) {
                // Handle machine metadata or daemon state updates from other clients (e.g., mobile app)
                const update = data.body as UpdateMachineBody;

                if (update.metadata) {
                    logger.debug('[API MACHINE] Received external metadata update');
                    this.machine.metadata = decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(update.metadata.value));
                    this.machine.metadataVersion = update.metadata.version;
                }

                if (update.daemonState) {
                    logger.debug('[API MACHINE] Received external daemon state update');
                    this.machine.daemonState = decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(update.daemonState.value));
                    this.machine.daemonStateVersion = update.daemonState.version;
                }
            } else {
                logger.debug(`[API MACHINE] Received unknown update type: ${(data.body as any).t}`);
            }
        });

        this.socket.on('connect_error', (error) => {
            logger.debug(`[API MACHINE] Connection error: ${error.message}`);
            // On boot the relay may not be ready yet. An initial connection
            // failure does not emit disconnect, so start retries here too.
            this.startSmartReconnect();
        });

        this.socket.io.on('error', (error: any) => {
            logger.debug('[API MACHINE] Socket error:', error);
        });
    }

    private startKeepAlive() {
        this.stopKeepAlive();
        this.keepAliveInterval = setInterval(() => {
            const payload = {
                machineId: this.machine.id,
                time: Date.now()
            };
            if (process.env.DEBUG) {
                logger.debugLargeJson(`[API MACHINE] Emitting machine-alive`, payload);
            }
            this.socket.emit('machine-alive', payload);

            // Re-detect CLI availability and push metadata update if changed
            const newAvailability = detectCLIAvailability();
            const prev = this.lastKnownCLIAvailability;
            const newResumeSupport = detectResumeSupport();
            const prevResume = this.lastKnownResumeSupport;
            const cliAvailabilityChanged = !prev || prev.claude !== newAvailability.claude || prev.codex !== newAvailability.codex;
            const resumeSupportChanged = !prevResume
                || prevResume.rpcAvailable !== newResumeSupport.rpcAvailable
                || prevResume.happyAgentAuthenticated !== newResumeSupport.happyAgentAuthenticated;

            this.syncResumeSessionRpcRegistration(newResumeSupport.rpcAvailable);
            void this.refreshCliCapabilities();

            if (cliAvailabilityChanged || resumeSupportChanged) {
                this.lastKnownCLIAvailability = newAvailability;
                this.lastKnownResumeSupport = newResumeSupport;
                this.updateMachineMetadata((metadata) => ({
                    ...(metadata || {} as any),
                    cliAvailability: newAvailability,
                    resumeSupport: newResumeSupport,
                })).catch((err) => {
                    logger.debug('[API MACHINE] Failed to update machine capabilities:', err);
                });
            }
        }, 20000);
        logger.debug('[API MACHINE] Keep-alive started (20s interval)');
    }

    /** Refreshes the catalogs advertised by the installed Claude and Codex CLIs. */
    private async refreshCliCapabilities(force = false): Promise<void> {
        if (this.capabilityRefreshInFlight) {
            // A forced refresh must run after an older discovery finishes, since
            // the updater may have activated a newer binary while it was in flight.
            await this.capabilityRefreshInFlight.catch(() => undefined);
            if (!force) return;
            return this.refreshCliCapabilities(true);
        }

        const codexVersion = detectCodexVersion();
        const claudeVersion = detectClaudeVersion();
        if (force && !codexVersion) throw new Error('无法检测 Codex 版本，请检查机器上的 Codex 安装。');
        if (!force
            && codexVersion === this.lastKnownCodexVersion
            && claudeVersion === this.lastKnownClaudeVersion
            && this.machine.metadata?.cliCapabilities) {
            return;
        }

        const refresh = async () => {
            const [codex, claude] = await Promise.all([
                codexVersion ? discoverCodexCapabilities(homedir(), { strict: true }) : Promise.resolve({ models: [], skills: [], skillsError: undefined }),
                claudeVersion ? discoverClaudeCapabilities() : Promise.resolve({ models: [], skills: [] }),
            ]);
            if (codexVersion && !codex.models.length) throw new Error('Codex 未返回可用模型，请检查机器上的登录状态后重试。');
            await this.updateMachineMetadata((metadata) => ({
                ...(metadata || {} as MachineMetadata),
                cliCapabilities: {
                    codex: { version: codexVersion, models: codex.models,
                        skills: codex.skillsError ? metadata?.cliCapabilities?.codex?.skills ?? [] : codex.skills },
                    claude: { version: claudeVersion, ...claude },
                    discoveredAt: Date.now(),
                },
                codexVersion,
                codexModels: codex.models,
            }), true);
            this.lastKnownCodexVersion = codexVersion;
            this.lastKnownClaudeVersion = claudeVersion;
        };
        const job = refresh();
        this.capabilityRefreshInFlight = job;
        try {
            await job;
        } catch (error) {
            logger.debug('[API MACHINE] Failed to refresh CLI capabilities:', error);
            if (force) throw new Error('模型与档位同步失败，已保留上次的列表。请检查 Codex 登录状态和网络后重试。');
        } finally {
            if (this.capabilityRefreshInFlight === job) this.capabilityRefreshInFlight = null;
        }
    }

    private startSmartReconnect() {
        if (this.reconnectInterval) return;

        this.reconnectInterval = setInterval(() => {
            if (this.socket.connected) {
                clearInterval(this.reconnectInterval!);
                this.reconnectInterval = null;
                return;
            }
            if (!shouldReconnect()) {
                logger.debug('[API MACHINE] Still not ready to reconnect');
                return;
            }
            logger.debug('[API MACHINE] Attempting reconnect');
            this.socket.connect();
        }, 3000);

        if (shouldReconnect()) {
            logger.debug('[API MACHINE] Network up + lid open — reconnecting in 1s');
            setTimeout(() => { if (!this.socket.connected) this.socket.connect() }, 1000);
        }
    }

    private stopKeepAlive() {
        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval);
            this.keepAliveInterval = null;
            logger.debug('[API MACHINE] Keep-alive stopped');
        }
    }

    shutdown() {
        logger.debug('[API MACHINE] Shutting down');
        this.stopPreviewTunnel?.();
        this.stopKeepAlive();
        if (this.reconnectInterval) {
            clearInterval(this.reconnectInterval);
            this.reconnectInterval = null;
        }
        if (this.socket) {
            this.socket.close();
            logger.debug('[API MACHINE] Socket closed');
        }
    }
}
