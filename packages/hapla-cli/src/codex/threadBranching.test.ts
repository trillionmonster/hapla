import { describe, expect, it } from 'vitest';
import { resolveCodexForkPoint } from './threadBranching';

const turn = (id: string, text?: string) => ({ id, items: text ? [{ type: 'userMessage', text }] : [{ type: 'agentMessage', text: 'answer' }] });

describe('resolveCodexForkPoint', () => {
    it('uses an empty sibling boundary when re-editing the first persisted user turn', () => {
        expect(resolveCodexForkPoint([turn('user-1', 'first'), turn('agent-1')], { userOrdinal: 0, userText: 'first' })).toMatchObject({
            target: { id: 'user-1' },
            previousTurnId: undefined,
        });
    });

    it('forks after the preceding turn for a middle-message edit', () => {
        expect(resolveCodexForkPoint([
            turn('user-1', 'first'), turn('agent-1'), turn('user-2', 'second'), turn('agent-2'),
        ], { userOrdinal: 1, userText: 'second' })).toMatchObject({ target: { id: 'user-2' }, previousTurnId: 'agent-1' });
    });

    it('ignores viewport-local ordinals and refuses ambiguous repeated prompts',()=>{
        expect(resolveCodexForkPoint([turn('first','old'),turn('latest','latest')],{userOrdinal:0,userText:'latest'})?.target.id).toBe('latest');
        expect(resolveCodexForkPoint([turn('one','same'),turn('two','same')],{userOrdinal:1,userText:'same'})).toBeNull();
        expect(resolveCodexForkPoint([turn('one','same'),turn('two','same')],{turnId:'two',userText:'same'})?.target.id).toBe('two');
    });
    it('falls back to persisted text and rejects unknown messages', () => {
        expect(resolveCodexForkPoint([turn('user-1', 'hello\nmetadata')], { userText: 'hello' })?.target.id).toBe('user-1');
        expect(resolveCodexForkPoint([turn('user-1', 'hello')], { userText: 'missing' })).toBeNull();
    });
});
