import { describe, expect, it } from 'vitest';
import { messageRequestKey, parseOutbox, recoverOutboxRequest } from './messageOutbox';
describe('encrypted durable outbox',()=>{
    it('restores the same cipher and id after reload without automatically executing ambiguous input',()=>{
        const raw=JSON.stringify([['session',[{localId:'same-id',content:'cipher-only',requestKey:'digest'}]]]);
        expect(parseOutbox(raw).get('session')).toEqual([{localId:'same-id',content:'cipher-only',requestKey:'digest',failed:true}]);
    });
    it('matches an unchanged retry but distinguishes changed content and branch',()=>{
        const original=messageRequestKey(['question','a']);
        expect(messageRequestKey(['question','a'])).toBe(original);
        expect(messageRequestKey(['changed','a'])).not.toBe(original);
        expect(messageRequestKey(['question','b'])).not.toBe(original);
    });
    it('fails visibly on corruption instead of deleting unacknowledged questions',()=>{
        expect(()=>parseOutbox('{}')).toThrow('待发消息');
        expect(()=>parseOutbox('[["session",[{}]]]')).toThrow('损坏');
    });
});

it('re-encrypts an ambiguous retry for a replacement runtime while preserving its submission id',async()=>{
    const payload={role:'user',content:{type:'text',text:'question'},meta:{codexInputId:'same-id'}};
    const outbox=new Map([['old',[{localId:'same-id',content:'old-cipher',requestKey:'digest',failed:true}]]]);
    const recovered=await recoverOutboxRequest(outbox,['new','old'],'new','digest',{getSessionEncryption:id=>({decryptRaw:async value=>value==='old-cipher'?payload:null,encryptRawRecord:async value=>id+':'+value.meta.codexInputId})});
    expect(recovered).toEqual({localId:'same-id',content:'new:same-id',requestKey:'digest',failed:false});
    expect(outbox.get('old')).toEqual([]);
    expect(outbox.get('new')).toEqual([recovered]);
});
