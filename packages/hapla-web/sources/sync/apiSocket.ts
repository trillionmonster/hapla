import { io, Socket } from 'socket.io-client';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { TokenStorage } from '@/auth/tokenStorage';
import { Encryption } from './encryption/encryption';
import { storage } from './storage';
import { loadedWebRelease, requestWebReleaseCheck } from '@/utils/webRelease';

export function getHaplaClientId(): string {
    const platform: string = Platform.OS; // 'ios' | 'android' | 'web'
    const version = Constants.expoConfig?.version || '0.0.0';
    if (platform === 'web' && typeof document !== 'undefined') {
        const release = loadedWebRelease([
            ...Array.from(document.scripts, (script) => script.src),
            ...Array.from(document.querySelectorAll<HTMLLinkElement>('link[href]'), (link) => link.href),
        ]);
        if (release) return `${platform}/${version}+${release}`;
    }
    return `${platform}/${version}`;
}

//
// Types
//

export interface SyncSocketConfig {
    endpoint: string;
    token: string;
}

export interface SyncSocketState {
    isConnected: boolean;
    connectionStatus: 'disconnected' | 'connecting' | 'connected' | 'error';
    lastError: Error | null;
}

export type SyncSocketListener = (state: SyncSocketState) => void;

//
// Main Class
//

class ApiSocket {

    // State
    private socket: Socket | null = null;
    private config: SyncSocketConfig | null = null;
    private encryption: Encryption | null = null;
    private messageHandlers: Map<string, (data: any) => void> = new Map();
    private reconnectedListeners: Set<() => void> = new Set();
    private statusListeners: Set<(status: 'disconnected' | 'connecting' | 'connected' | 'error') => void> = new Set();
    private currentStatus: 'disconnected' | 'connecting' | 'connected' | 'error' = 'disconnected';

    //
    // Initialization
    //

    initialize(config: SyncSocketConfig, encryption: Encryption) {
        this.config = config;
        this.encryption = encryption;
        this.connect();
    }

    //
    // Connection Management
    //

    connect() {
        if (!this.config || this.socket) {
            return;
        }

        this.updateStatus('connecting');

        this.socket = io(this.config.endpoint, {
            path: '/v1/updates',
            auth: {
                token: this.config.token,
                clientType: 'user-scoped' as const,
                haplaClient: getHaplaClientId()
            },
            transports: ['websocket'],
            reconnection: true,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
            reconnectionAttempts: Infinity
        });

        this.setupEventHandlers();
    }

    disconnect() {
        if (this.socket) {
            this.socket.disconnect();
            this.socket = null;
        }
        this.updateStatus('disconnected');
    }

    //
    // Listener Management
    //

    onReconnected = (listener: () => void) => {
        this.reconnectedListeners.add(listener);
        return () => this.reconnectedListeners.delete(listener);
    };

    onStatusChange = (listener: (status: 'disconnected' | 'connecting' | 'connected' | 'error') => void) => {
        this.statusListeners.add(listener);
        // Immediately notify with current status
        listener(this.currentStatus);
        return () => this.statusListeners.delete(listener);
    };

    //
    // Message Handling
    //

    onMessage(event: string, handler: (data: any) => void) {
        this.messageHandlers.set(event, handler);
        return () => this.messageHandlers.delete(event);
    }

    offMessage(event: string, handler: (data: any) => void) {
        this.messageHandlers.delete(event);
    }

    /**
     * RPC call for sessions - uses session-specific encryption
     */
    async sessionRPC<R, A>(sessionId: string, method: string, params: A, timeoutMs = 50_000): Promise<R> {
        const socket = this.requireConnectedSocket();
        const sessionEncryption = this.encryption?.getSessionEncryption(sessionId);
        if (!sessionEncryption) {
            throw new Error(`Session encryption not found for ${sessionId}`);
        }
        
        const encryptedParams = await sessionEncryption.encryptRaw(params);
        this.requireConnectedSocket(socket);
        const result = await socket.timeout(timeoutMs).emitWithAck('rpc-call', {
            method: `${sessionId}:${method}`,
            params: encryptedParams
        });
        
        if (result.ok) {
            return await sessionEncryption.decryptRaw(result.result) as R;
        }
        throw new Error(typeof result.error === 'string' && result.error.trim() ? result.error : 'RPC call failed');
    }

    /** Commands must check the encrypted handler result as well as the relay ACK.
     * RpcHandlerManager encrypts thrown errors inside an otherwise successful ACK.
     * Keep sessionRPC's result contract for callers that inspect domain errors. */
    async sessionCommand<R, A>(sessionId: string, method: string, params: A, timeoutMs?: number): Promise<R> {
        const result = await this.sessionRPC<R, A>(sessionId, method, params, timeoutMs);
        if (result && typeof result === 'object' && 'error' in result && typeof result.error === 'string' && result.error.trim()) {
            throw new Error(result.error);
        }
        return result;
    }

    /**
     * RPC call for machines - uses legacy/global encryption (for now)
     */
    async machineRPC<R, A>(machineId: string, method: string, params: A, timeoutMs = 20_000): Promise<R> {
        const socket = this.requireConnectedSocket();
        const machineEncryption = this.encryption?.getMachineEncryption(machineId);
        if (!machineEncryption) {
            throw new Error(`Machine encryption not found for ${machineId}`);
        }

        const encryptedParams = await machineEncryption.encryptRaw(params);
        this.requireConnectedSocket(socket);
        const result = await socket.timeout(timeoutMs).emitWithAck('rpc-call', {
            method: `${machineId}:${method}`,
            params: encryptedParams
        });

        if (result.ok) {
            return await machineEncryption.decryptRaw(result.result) as R;
        }
        throw new Error(result.error || 'RPC call failed');
    }

    send(event: string, data: any) {
        this.socket!.emit(event, data);
        return true;
    }

    async emitWithAck<T = any>(event: string, data: any): Promise<T> {
        if (!this.socket) {
            throw new Error('Socket not connected');
        }
        return await this.socket.emitWithAck(event, data);
    }

    //
    // HTTP Requests
    //

    async request(path: string, options?: RequestInit): Promise<Response> {
        if (!this.config) {
            throw new Error('SyncSocket not initialized');
        }

        const credentials = await TokenStorage.getCredentials();
        if (!credentials) {
            throw new Error('No authentication credentials');
        }

        const url = `${this.config.endpoint}${path}`;
        const headers = {
            'Authorization': `Bearer ${credentials.token}`,
            'X-Hapla-Client': getHaplaClientId(),
            ...options?.headers
        };

        return fetch(url, {
            ...options,
            headers
        });
    }

    //
    // Token Management
    //

    updateToken(newToken: string) {
        if (this.config && this.config.token !== newToken) {
            this.config.token = newToken;

            if (this.socket) {
                this.disconnect();
                this.connect();
            }
        }
    }

    //
    // Private Methods
    //

    private requireConnectedSocket(expected?: Socket): Socket {
        // WebKit may keep an existing WebSocket OPEN after the browser goes
        // offline. Fail new commands before encryption/ACK registration instead
        // of leaving the composer waiting for the transport's timeout.
        if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.onLine === false) {
            throw new Error('网络已离线，请恢复连接后重试');
        }
        const socket = this.socket;
        if (!socket?.connected || (expected && socket !== expected)) {
            throw new Error('Socket not connected');
        }
        return socket;
    }

    private isVerboseLogging(): boolean {
        try {
            return storage.getState().localSettings.verboseLogging;
        } catch {
            return false;
        }
    }

    private updateStatus(status: 'disconnected' | 'connecting' | 'connected' | 'error') {
        if (this.currentStatus !== status) {
            this.currentStatus = status;
            this.statusListeners.forEach(listener => listener(status));
        }
    }

    private setupEventHandlers() {
        if (!this.socket) return;

        // Connection events
        this.socket.on('connect', () => {
            if (this.isVerboseLogging()) {
                console.log('🔌 SyncSocket: Connected, recovered: ' + this.socket?.recovered);
                console.log('🔌 SyncSocket: Socket ID:', this.socket?.id);
            }
            this.updateStatus('connected');
            requestWebReleaseCheck('socket-reconnected');
            if (!this.socket?.recovered) {
                this.reconnectedListeners.forEach(listener => listener());
            }
        });

        this.socket.on('disconnect', (reason) => {
            if (this.isVerboseLogging()) {
                console.log('🔌 SyncSocket: Disconnected', reason);
            }
            this.updateStatus('disconnected');
        });

        // Error events
        this.socket.on('connect_error', (error) => {
            if (this.isVerboseLogging()) {
                console.error('🔌 SyncSocket: Connection error', error);
            }
            this.updateStatus('error');
        });

        this.socket.on('error', (error) => {
            if (this.isVerboseLogging()) {
                console.error('🔌 SyncSocket: Error', error);
            }
            this.updateStatus('error');
        });

        // Message handling
        this.socket.onAny((event, data) => {
            if (this.isVerboseLogging()) {
                console.log(`📥 SyncSocket: Received event '${event}':`, JSON.stringify(data).substring(0, 200));
            }
            const handler = this.messageHandlers.get(event);
            if (handler) {
                handler(data);
            }
        });
    }
}

//
// Singleton Export
//

export const apiSocket = new ApiSocket();
