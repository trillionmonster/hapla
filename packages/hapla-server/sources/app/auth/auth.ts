import * as privacyKit from "privacy-kit";
import { log } from "@/utils/log";

interface TokenCacheEntry {
    userId: string;
    extras?: any;
    cachedAt: number;
}

interface AuthTokens {
    generator: Awaited<ReturnType<typeof privacyKit.createPersistentTokenGenerator>>;
    verifier: Awaited<ReturnType<typeof privacyKit.createPersistentTokenVerifier>>;
    legacyVerifier: Awaited<ReturnType<typeof privacyKit.createPersistentTokenVerifier>>;
    githubVerifier: Awaited<ReturnType<typeof privacyKit.createEphemeralTokenVerifier>>;
    legacyGithubVerifier: Awaited<ReturnType<typeof privacyKit.createEphemeralTokenVerifier>>;
    githubGenerator: Awaited<ReturnType<typeof privacyKit.createEphemeralTokenGenerator>>;
}

class AuthModule {
    private tokenCache = new Map<string, TokenCacheEntry>();
    private tokens: AuthTokens | null = null;
    
    async init(): Promise<void> {
        if (this.tokens) {
            return; // Already initialized
        }
        
        log({ module: 'auth' }, 'Initializing auth module...');
        
        const masterSecret = process.env.HAPLA_MASTER_SECRET;
        if (!masterSecret) {
            throw new Error('HAPLA_MASTER_SECRET is required');
        }

        const generator = await privacyKit.createPersistentTokenGenerator({
            service: 'hapla',
            seed: masterSecret,
        });

        const verifier = await privacyKit.createPersistentTokenVerifier({
            service: 'hapla',
            publicKey: Uint8Array.from(generator.publicKey)
        });

        // Read-only verifier for tokens issued before the Hapla rename.
        const legacyGenerator = await privacyKit.createPersistentTokenGenerator({
            service: 'handy',
            seed: masterSecret,
        });
        const legacyVerifier = await privacyKit.createPersistentTokenVerifier({
            service: 'handy',
            publicKey: Uint8Array.from(legacyGenerator.publicKey),
        });

        const githubGenerator = await privacyKit.createEphemeralTokenGenerator({
            service: 'github-hapla',
            seed: masterSecret,
            ttl: 5 * 60 * 1000 // 5 minutes
        });

        const githubVerifier = await privacyKit.createEphemeralTokenVerifier({
            service: 'github-hapla',
            publicKey: Uint8Array.from(githubGenerator.publicKey),
        });

        // Allows an OAuth flow started immediately before a rolling upgrade to finish.
        const legacyGithubGenerator = await privacyKit.createEphemeralTokenGenerator({
            service: 'github-happy',
            seed: masterSecret,
            ttl: 5 * 60 * 1000,
        });
        const legacyGithubVerifier = await privacyKit.createEphemeralTokenVerifier({
            service: 'github-happy',
            publicKey: Uint8Array.from(legacyGithubGenerator.publicKey),
        });

        this.tokens = { generator, verifier, legacyVerifier, githubVerifier, legacyGithubVerifier, githubGenerator };
        
        log({ module: 'auth' }, 'Auth module initialized');
    }
    
    async createToken(userId: string, extras?: any): Promise<string> {
        if (!this.tokens) {
            throw new Error('Auth module not initialized');
        }
        
        const payload: any = { user: userId };
        if (extras) {
            payload.extras = extras;
        }
        
        const token = await this.tokens.generator.new(payload);
        
        // Cache the token immediately
        this.tokenCache.set(token, {
            userId,
            extras,
            cachedAt: Date.now()
        });
        
        return token;
    }
    
    async verifyToken(token: string): Promise<{ userId: string; extras?: any } | null> {
        // Check cache first
        const cached = this.tokenCache.get(token);
        if (cached) {
            return {
                userId: cached.userId,
                extras: cached.extras
            };
        }
        
        // Cache miss - verify token
        if (!this.tokens) {
            throw new Error('Auth module not initialized');
        }
        
        try {
            let verified = null;
            for (const verifier of [this.tokens.verifier, this.tokens.legacyVerifier]) {
                try {
                    verified = await verifier.verify(token);
                } catch {
                    // Try the next format during the migration window.
                }
                if (verified) break;
            }
            if (!verified) {
                return null;
            }
            
            const userId = verified.user as string;
            const extras = verified.extras;
            
            // Cache the result permanently
            this.tokenCache.set(token, {
                userId,
                extras,
                cachedAt: Date.now()
            });
            
            return { userId, extras };
            
        } catch (error) {
            log({ module: 'auth', level: 'error' }, `Token verification failed: ${error}`);
            return null;
        }
    }
    
    invalidateUserTokens(userId: string): void {
        // Remove all tokens for a specific user
        // This is expensive but rarely needed
        for (const [token, entry] of this.tokenCache.entries()) {
            if (entry.userId === userId) {
                this.tokenCache.delete(token);
            }
        }
        
        log({ module: 'auth' }, `Invalidated tokens for user: ${userId}`);
    }
    
    invalidateToken(token: string): void {
        this.tokenCache.delete(token);
    }
    
    getCacheStats(): { size: number; oldestEntry: number | null } {
        if (this.tokenCache.size === 0) {
            return { size: 0, oldestEntry: null };
        }
        
        let oldest = Date.now();
        for (const entry of this.tokenCache.values()) {
            if (entry.cachedAt < oldest) {
                oldest = entry.cachedAt;
            }
        }
        
        return {
            size: this.tokenCache.size,
            oldestEntry: oldest
        };
    }
    
    async createGithubToken(userId: string): Promise<string> {
        if (!this.tokens) {
            throw new Error('Auth module not initialized');
        }
        
        const payload = { user: userId, purpose: 'github-oauth' };
        const token = await this.tokens.githubGenerator.new(payload);
        
        return token;
    }

    async verifyGithubToken(token: string): Promise<{ userId: string } | null> {
        if (!this.tokens) {
            throw new Error('Auth module not initialized');
        }
        
        try {
            let verified = null;
            for (const verifier of [this.tokens.githubVerifier, this.tokens.legacyGithubVerifier]) {
                try {
                    verified = await verifier.verify(token);
                } catch {
                    // Try the next format during the migration window.
                }
                if (verified) break;
            }
            if (!verified) {
                return null;
            }
            
            return { userId: verified.user as string };
        } catch (error) {
            log({ module: 'auth', level: 'error' }, `GitHub token verification failed: ${error}`);
            return null;
        }
    }

    // Cleanup old entries (optional - can be called periodically)
    cleanup(): void {
        // Note: Since tokens are cached "forever" as requested,
        // we don't do automatic cleanup. This method exists if needed later.
        const stats = this.getCacheStats();
        log({ module: 'auth' }, `Token cache size: ${stats.size} entries`);
    }
}

// Global instance
export const auth = new AuthModule();
