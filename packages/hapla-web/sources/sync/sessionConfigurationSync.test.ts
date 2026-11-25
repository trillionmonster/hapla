import { describe, expect, it, vi } from 'vitest';
vi.mock('./storage',()=>({storage:{getState:()=>({sessions:{root:{id:'root',conversationId:'c'}}})}}));
vi.mock('./apiSocket',()=>({apiSocket:{request:vi.fn(),emitWithAck:vi.fn()}}));
import { apiSocket } from './apiSocket';
import { persistSessionConfiguration, writeQueuedSessionConfiguration } from './sessionConfigurationSync';
const cipher={decryptRaw:async(value:string)=>JSON.parse(value),encryptMetadata:async(value:unknown)=>JSON.stringify(value)};
const encryption={getSessionEncryption:()=>cipher} as any;
describe('encrypted configuration compare and swap',()=>{
    it('rebases a single field on a concurrent edit without dropping full runtime metadata',async()=>{
        const initial={path:'/workspace',skills:[{name:'retained'}],executionConfiguration:{revision:1,values:{effort:'low'}}};
        const latest={...initial,executionConfiguration:{revision:2,values:{effort:'low',permissionMode:'read-only'}}};
        vi.mocked(apiSocket.request).mockResolvedValue({ok:true,json:async()=>({metadata:JSON.stringify(initial),metadataVersion:5,conversationId:'c'})} as any);
        vi.mocked(apiSocket.emitWithAck).mockResolvedValueOnce({result:'version-mismatch',metadata:JSON.stringify(latest),version:6}).mockImplementationOnce(async(_event,data:any)=>({result:'success',metadata:data.metadata,version:7}));
        const apply=vi.fn();
        await persistSessionConfiguration('root',{id:'root',conversationId:'c'} as any,{effort:'high'},encryption,apply);
        expect(JSON.parse((apiSocket.emitWithAck as any).mock.calls.at(-1)[1].metadata)).toMatchObject({skills:initial.skills,executionConfiguration:{revision:3,values:{effort:'high',permissionMode:'read-only'}}});
        expect(apply).toHaveBeenCalledWith(expect.objectContaining({id:'root',metadataVersion:7}));
    });
    it('rejects cross-conversation roots and leaves the local selection available for retry',async()=>{
        vi.mocked(apiSocket.request).mockResolvedValue({ok:true,json:async()=>({conversationId:'other'})} as any);
        await expect(persistSessionConfiguration('root',{conversationId:'c'} as any,{effort:'high'},encryption,vi.fn())).rejects.toThrow('归属');
    });
});

it('does not replay an acknowledged field when a second local field is changed during the write',async()=>{
    const patches=new Map<string,any>([['root',{effort:'high'}]]);
    let current:any={executionConfiguration:{revision:1,values:{effort:'low'}}}; let writes=0;
    vi.mocked(apiSocket.request).mockImplementation(async()=>({ok:true,json:async()=>({metadata:JSON.stringify(current),metadataVersion:writes+1,conversationId:'c'})}) as any);
    vi.mocked(apiSocket.emitWithAck).mockImplementation(async(_event,data:any)=>{
        writes++; current=JSON.parse(data.metadata);
        if(writes===1) patches.set('root',{collaborationMode:'plan'});
        const answer={result:'success',metadata:JSON.stringify(current),version:writes+1};
        if(writes===1) current.executionConfiguration.values.effort='medium'; // another device after our effort ACK
        return answer;
    });
    await writeQueuedSessionConfiguration('root','root',patches,()=>encryption,vi.fn());
    expect(current.executionConfiguration.values).toEqual({effort:'medium',collaborationMode:'plan'});
    expect(writes).toBe(2); expect(patches.size).toBe(0);
});
