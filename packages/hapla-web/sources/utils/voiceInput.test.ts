import { describe, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { appendDictation, getDictationPage, isDictationMessage, PCM_WORKLET, releaseVoiceResources, voiceInputError, type VoiceResources } from './voiceInput';

describe('dictation page routing', () => {
    it('does not open a LAN recorder from the public site', () => {
        expect(getDictationPage('https://192.168.42.10:8766/', 'http://203.0.113.10:12345/')).toBeNull();
        expect(getDictationPage('https://192.168.1.2/', 'http://chat.example.com/')).toBeNull();
        expect(getDictationPage('https://[fd00::1]/', 'http://chat.example.com/')).toBeNull();
    });
    it('preserves an explicitly configured LAN recorder for a LAN page', () => {
        expect(getDictationPage('https://192.168.42.10:8766/', 'http://192.168.42.10:12345/')?.href).toBe('https://192.168.42.10:8766/');
    });
    it('accepts a configured public HTTPS recorder', () => {
        expect(getDictationPage('https://voice.example.com/', 'http://203.0.113.10:12345/')?.origin).toBe('https://voice.example.com');
    });
    it.each([undefined, '', 'invalid', 'http://voice.example.com/', 'javascript:alert(1)', 'https://user:pass@voice.example.com/'])('does not open an invalid or missing recorder: %s', configuredUrl => {
        expect(getDictationPage(configuredUrl, 'http://203.0.113.10:12345/')).toBeNull();
    });
});

describe('dictation bridge', () => {
    it('preserves the existing draft and appends finalized paragraphs once', () => {
        expect(appendDictation('已有任务', ' 第一段 ')).toBe('已有任务\n第一段');
        expect(appendDictation('已有任务\n', '第二段')).toBe('已有任务\n第二段');
        expect(appendDictation('已有任务', '  ')).toBe('已有任务');
    });
    it('rejects forged origins, popup sources and stale recording channels', () => {
        const popup = {} as Window;
        const event = { origin: 'https://192.168.42.10:8766', source: popup, data: { type: 'hapla-asr', channel: 'active', text: '文字' } };
        expect(isDictationMessage(event, event.origin, popup, 'active')).toBe(true);
        expect(isDictationMessage({ ...event, origin: 'https://other.test' }, event.origin, popup, 'active')).toBe(false);
        expect(isDictationMessage({ ...event, source: {} as Window }, event.origin, popup, 'active')).toBe(false);
        expect(isDictationMessage(event, event.origin, popup, 'previous')).toBe(false);
    });
});

describe('device-rate capture', () => {
    it.each([16000, 44100, 48000])('converts one second at %i Hz to 16000 PCM samples and flushes the tail', rate => {
        const messages: (ArrayBuffer | string)[] = [];
        let Processor: any;
        runInNewContext(PCM_WORKLET, {
            sampleRate: rate,
            AudioWorkletProcessor: class { port = { postMessage: (value: ArrayBuffer | string) => messages.push(value), onmessage: null }; },
            registerProcessor: (_name: string, value: any) => { Processor = value; },
        });
        const processor = new Processor();
        for (let offset = 0; offset < rate; offset += 128) {
            processor.process([[new Float32Array(Math.min(128, rate - offset)).fill(0.5)]]);
        }
        processor.port.onmessage({ data: 'flush' });
        const pcm = messages.filter(value => typeof value !== 'string') as ArrayBuffer[];
        expect(pcm.reduce((count, buffer) => count + buffer.byteLength / 2, 0)).toBe(16000);
        expect(pcm.every(buffer => Array.from(new Int16Array(buffer)).every(sample => sample === 16384))).toBe(true);
        expect(messages.at(-1)).toBe('flushed');
        const count = messages.length;
        expect(processor.process([[new Float32Array(128)]])).toBe(false);
        expect(messages).toHaveLength(count);
    });

    it('releases devices and pending work even when AudioContext shutdown rejects', async () => {
        const calls: string[] = [];
        const track = { stop: vi.fn(() => calls.push('track')) };
        const port = { onmessage: vi.fn(), close: vi.fn() };
        const node = { port, onprocessorerror: vi.fn(), disconnect: vi.fn() };
        const owner = {
            stream: { getTracks: () => [track] }, node,
            source: { disconnect: vi.fn() }, output: { disconnect: vi.fn() },
            socket: { removeAllListeners: () => calls.push('listeners'), disconnect: () => calls.push('socket') },
            audio: { close: vi.fn().mockRejectedValue(new Error('already closed')) },
            cancelConnect: vi.fn(), flush: vi.fn(),
        };
        const cancel = owner.cancelConnect; const flush = owner.flush;
        await expect(releaseVoiceResources(owner as unknown as VoiceResources)).resolves.toBeUndefined();
        expect(track.stop).toHaveBeenCalledOnce();
        expect(port.onmessage).toBeNull();
        expect(node.onprocessorerror).toBeNull();
        expect(port.close).toHaveBeenCalledOnce();
        expect(owner.source.disconnect).toHaveBeenCalledOnce();
        expect(owner.output.disconnect).toHaveBeenCalledOnce();
        expect(cancel).toHaveBeenCalledOnce(); expect(flush).toHaveBeenCalledOnce();
        expect(calls.indexOf('listeners')).toBeLessThan(calls.indexOf('socket'));
    });

    it('explains permission and hardware failures', () => {
        expect(voiceInputError({ name: 'NotAllowedError' })).toContain('权限');
        expect(voiceInputError({ name: 'NotReadableError' })).toContain('被占用');
        expect(voiceInputError({ name: 'NotFoundError' })).toContain('没有找到');
    });
});
