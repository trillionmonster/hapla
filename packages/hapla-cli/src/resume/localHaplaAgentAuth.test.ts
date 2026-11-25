import { it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readLocalHaplaAgentCredentials, getLocalHaplaAgentCredentialPath } from './localHaplaAgentAuth';
it('uses the current login for standalone resume and never falls back to a stale legacy account', () => {
    const root = mkdtempSync(join(tmpdir(), 'hapla-resume-auth-'));
    try {
        const secret = Buffer.alloc(32,1).toString('base64');
        writeFileSync(join(root,'agent.key'),JSON.stringify({token:'old',secret}));
        expect(readLocalHaplaAgentCredentials(root)?.token).toBe('old');
        writeFileSync(join(root,'access.key'),JSON.stringify({token:'current',secret}));
        expect(getLocalHaplaAgentCredentialPath(root)).toBe(join(root,'access.key'));
        expect(readLocalHaplaAgentCredentials(root)?.token).toBe('current');
        writeFileSync(join(root,'access.key'),JSON.stringify({token:'machine-only',encryption:{publicKey:secret,machineKey:secret}}));
        expect(readLocalHaplaAgentCredentials(root)).toBeNull();
    } finally { rmSync(root,{recursive:true,force:true}); }
});
