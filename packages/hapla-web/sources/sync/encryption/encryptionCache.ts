import { AgentState, Metadata, MachineMetadata } from '../storageTypes';
import { DecryptedMessage } from '../storageTypes';
import { ByteLruCache } from '../sessionResources';

interface CacheEntry<T> {
    data: T;
    accessTime: number;
}

/**
 * In-memory cache for decrypted session data to avoid expensive re-decryption
 * Uses sessionId + version as keys for agent state and metadata
 * Uses messageId as key for messages (immutable)
 */
export class EncryptionCache {
    private agentStateCache = new ByteLruCache<AgentState>(2 * 1024 * 1024);
    private metadataCache = new ByteLruCache<Metadata>(2 * 1024 * 1024);
    private messageCache = new ByteLruCache<DecryptedMessage>(4 * 1024 * 1024);
    private machineMetadataCache = new Map<string, CacheEntry<MachineMetadata>>();
    private daemonStateCache = new Map<string, CacheEntry<any>>();
    
    // Configuration
    private readonly maxMachineMetadata = 500;
    private readonly maxDaemonStates = 500;

    /**
     * Get cached agent state for a session
     */
    getCachedAgentState(sessionId: string, version: number): AgentState | null {
        return this.agentStateCache.get(`${sessionId}:${version}`) ?? null;
    }

    /**
     * Cache agent state for a session
     */
    setCachedAgentState(sessionId: string, version: number, data: AgentState): void {
        this.agentStateCache.set(`${sessionId}:${version}`, data, sessionId);
    }

    /**
     * Get cached metadata for a session
     */
    getCachedMetadata(sessionId: string, version: number): Metadata | null {
        return this.metadataCache.get(`${sessionId}:${version}`) ?? null;
    }

    /**
     * Cache metadata for a session
     */
    setCachedMetadata(sessionId: string, version: number, data: Metadata): void {
        this.metadataCache.set(`${sessionId}:${version}`, data, sessionId);
    }

    /**
     * Get cached decrypted message
     */
    getCachedMessage(messageId: string): DecryptedMessage | null {
        const entry = this.messageCache.get(messageId);
        return entry ?? null;
    }

    /**
     * Cache decrypted message
     */
    setCachedMessage(messageId: string, data: DecryptedMessage, sessionId?: string): void {
        this.messageCache.set(messageId, data, sessionId);
    }

    /**
     * Get cached machine metadata
     */
    getCachedMachineMetadata(machineId: string, version: number): MachineMetadata | null {
        const key = `${machineId}:${version}`;
        const entry = this.machineMetadataCache.get(key);
        if (entry) {
            entry.accessTime = Date.now();
            return entry.data;
        }
        return null;
    }

    /**
     * Cache machine metadata
     */
    setCachedMachineMetadata(machineId: string, version: number, data: MachineMetadata): void {
        const key = `${machineId}:${version}`;
        this.machineMetadataCache.set(key, {
            data,
            accessTime: Date.now()
        });
        
        // Evict if over limit
        this.evictOldest(this.machineMetadataCache, this.maxMachineMetadata);
    }

    /**
     * Get cached daemon state
     */
    getCachedDaemonState(machineId: string, version: number): any | undefined {
        const key = `${machineId}:${version}`;
        const entry = this.daemonStateCache.get(key);
        if (entry) {
            entry.accessTime = Date.now();
            return entry.data;
        }
        return undefined;
    }

    /**
     * Cache daemon state (including null values)
     */
    setCachedDaemonState(machineId: string, version: number, data: any): void {
        const key = `${machineId}:${version}`;
        this.daemonStateCache.set(key, {
            data,
            accessTime: Date.now()
        });
        
        // Evict if over limit
        this.evictOldest(this.daemonStateCache, this.maxDaemonStates);
    }

    /**
     * Clear all cache entries for a specific machine
     */
    clearMachineCache(machineId: string): void {
        // Clear machine metadata and daemon state for this machine (all versions)
        for (const key of this.machineMetadataCache.keys()) {
            if (key.startsWith(`${machineId}:`)) {
                this.machineMetadataCache.delete(key);
            }
        }
        
        for (const key of this.daemonStateCache.keys()) {
            if (key.startsWith(`${machineId}:`)) {
                this.daemonStateCache.delete(key);
            }
        }
    }

    /**
     * Clear all cache entries for a specific session
     */
    clearSessionCache(sessionId: string): void {
        this.agentStateCache.clearOwner(sessionId);
        this.metadataCache.clearOwner(sessionId);
        this.messageCache.clearOwner(sessionId);
    }

    /**
     * Clear all cached data
     */
    clearAll(): void {
        this.agentStateCache.clear();
        this.metadataCache.clear();
        this.messageCache.clear();
        this.machineMetadataCache.clear();
        this.daemonStateCache.clear();
    }

    /**
     * Get cache statistics for debugging
     */
    getStats() {
        return {
            agentStates: this.agentStateCache.size,
            agentStateBytes: this.agentStateCache.bytes,
            metadataBytes: this.metadataCache.bytes,
            metadata: this.metadataCache.size,
            messages: this.messageCache.size,
            messageBytes: this.messageCache.bytes,
            machineMetadata: this.machineMetadataCache.size,
            daemonStates: this.daemonStateCache.size,
            totalEntries: this.agentStateCache.size + this.metadataCache.size + this.messageCache.size + 
                         this.machineMetadataCache.size + this.daemonStateCache.size
        };
    }

    /**
     * Evict oldest entries when cache exceeds limit (LRU eviction)
     */
    private evictOldest<T>(cache: Map<string, CacheEntry<T>>, maxSize: number): void {
        if (cache.size <= maxSize) {
            return;
        }

        // Find oldest entry by access time
        let oldestKey: string | null = null;
        let oldestTime = Infinity;
        
        for (const [key, entry] of cache.entries()) {
            if (entry.accessTime < oldestTime) {
                oldestTime = entry.accessTime;
                oldestKey = key;
            }
        }
        
        if (oldestKey) {
            cache.delete(oldestKey);
        }
    }
}
