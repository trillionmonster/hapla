import { it, expect } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TurnInputLedger } from './turnInputLedger';
it('retains native turn identities across runtime restarts independently of visible question order', () => {
    const root = mkdtempSync(join(tmpdir(), 'hapla-turn-ids-'));
    try {
        const file = join(root, 'root.json'); const ledger = new TurnInputLedger(file);
        ledger.record('old-history-message', { threadId: 'thread', turnId: 'turn-800' });
        ledger.record('steered-message', { threadId: 'thread', turnId: 'turn-800', steered: true });
        const restored = new TurnInputLedger(file);
        expect(restored.get('old-history-message')).toEqual({ threadId: 'thread', turnId: 'turn-800' });
        expect(restored.get('steered-message')?.steered).toBe(true);
        expect(statSync(file).mode & 0o777).toBe(0o600);
    } finally { rmSync(root, { recursive: true, force: true }); }
});
