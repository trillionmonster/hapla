import { describe, expect, it } from 'vitest';
import { configurationOwner, projectSessionConfiguration, preferencesPatch } from './sessionConfiguration';

describe('stable conversation configuration', () => {
    it('projects the same explicit intent onto replacement runtimes and fresh devices', () => {
        const config={revision:8,values:{permissionMode:'read-only' as const,effort:'high',collaborationMode:'plan' as const,serviceTier:'priority'}};
        const source={id:'source',createdAt:1,conversationId:'conversation',metadata:{}} as any;
        const replacement={id:'next',createdAt:2,conversationId:'conversation',metadata:{conversationRootSessionId:'source'}} as any;
        expect(configurationOwner(replacement,{source,next:replacement})).toBe('source');
        expect(projectSessionConfiguration(source,config)).toEqual(projectSessionConfiguration(replacement,config));
        expect(projectSessionConfiguration(replacement,config)).toMatchObject({permissionMode:'read-only',effortLevel:'high',codexPreferences:{collaborationMode:'plan',serviceTier:'priority'}});
    });
    it('uses actual runtime effort for inherited controls and retains explicit default choices',()=>{
        const row={metadata:{effectiveConfiguration:{effort:'high',permissionMode:'read-only'}}} as any;
        expect(projectSessionConfiguration(row,{revision:1,values:{}})).toMatchObject({effortLevel:'high',permissionMode:'read-only'});
        expect(projectSessionConfiguration(row,{revision:2,values:{effort:null,permissionMode:'default'}})).toMatchObject({effortLevel:'default',permissionMode:'default'});
    });
    it('patches only the changed preference so another device’s Plan choice is retained',()=>{
        expect(preferencesPatch({verbosity:'high'})).toEqual({verbosity:'high'});
        expect(preferencesPatch({serviceTier:'standard'})).toEqual({serviceTier:null});
    });
});
