import { describe, expect, it } from 'vitest';
import { resolveMessageModeMeta, resolveMessageCodexPreferenceMeta } from './messageMeta';
const model = { code: 'current', value: 'Current', supportedEffortLevels: ['low','high'], supportedServiceTiers: ['priority'] };
const session = { metadata: { flavor: 'codex', currentModelCode: 'current', models: [model] } } as any;
describe('outbound configuration semantics', () => {
    it('omits absent choices so a new device inherits native high/readonly/plan', () => {
        expect(resolveMessageModeMeta(session)).toEqual({});
        expect(resolveMessageCodexPreferenceMeta(session)).toEqual({});
    });
    it('keeps explicit resets separate from inheritance and preserves default approval', () => {
        const row = { ...session, configuration: { revision: 4, values: { model:null, effort:null, permissionMode:'default', verbosity:null, serviceTier:null, collaborationMode:'default' } } };
        expect(resolveMessageModeMeta(row)).toEqual({model:null,effort:null,permissionMode:'default'});
        expect(resolveMessageCodexPreferenceMeta(row)).toEqual({verbosity:null,serviceTier:null,collaborationMode:'default'});
    });
    it('preserves selected effort when discovery failed or the configured model is absent from its catalog', () => {
        expect(resolveMessageModeMeta({...session,modelMode:'current',effortLevel:'high'}, {cliCapabilities:{codex:{models:[]}}} as any).effort).toBe('high');
        expect(resolveMessageModeMeta({...session,metadata:{...session.metadata,currentModelCode:'custom'},modelMode:'custom',effortLevel:'high'}).effort).toBe('high');
    });
    it('reports unavailable choices instead of silently replacing them with defaults', () => {
        expect(()=>resolveMessageModeMeta({...session,modelMode:'retired'})).toThrow('不可用');
        expect(()=>resolveMessageModeMeta({...session,modelMode:'current',effortLevel:'ultra'})).toThrow('不支持');
    });
    it('maps advertised portable Fast and retains default reset semantics', () => {
        const row={...session,configuration:{revision:1,values:{serviceTier:'fast'}}};
        expect(resolveMessageCodexPreferenceMeta(row).serviceTier).toBe('priority');
        expect(resolveMessageCodexPreferenceMeta({...row,configuration:{revision:2,values:{serviceTier:null}}}).serviceTier).toBeNull();
        expect(()=>resolveMessageCodexPreferenceMeta({...row,metadata:{...session.metadata,models:[{...model,supportedServiceTiers:[]}]}})).toThrow('不支持');
    });
});
