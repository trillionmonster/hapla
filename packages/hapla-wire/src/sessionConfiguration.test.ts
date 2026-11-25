import { describe, it, expect } from 'vitest';
import { sessionConfigurationSchema } from './sessionConfiguration';
import { MessageMetaSchema } from './messageMeta';
import { sessionTextEventSchema } from './sessionProtocol';
describe('shared execution intent', () => {
    it('keeps omitted inheritance distinct from explicit native defaults and accepts Claude dontAsk', () => {
        expect(sessionConfigurationSchema.parse({ revision: 1, values: { model: null, effort: null, permissionMode: 'dontAsk' } }).values).toEqual({ model: null, effort: null, permissionMode: 'dontAsk' });
        expect(MessageMetaSchema.parse({ permissionMode: 'dontAsk' }).permissionMode).toBe('dontAsk');
    });
    it('retains a durable input revision without changing its target identity', () => {
        expect(sessionTextEventSchema.parse({ t: 'text', text: 'edited', inputEdit: { messageId: 'original', revision: 1 } }).inputEdit).toEqual({ messageId: 'original', revision: 1 });
        expect(sessionTextEventSchema.safeParse({ t: 'text', text: 'edited', inputEdit: { messageId: 'original', revision: 0 } }).success).toBe(false);
    });
});
