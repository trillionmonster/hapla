export function appendDictation(value: string, text: string): string {
    const trimmed = text.trim();
    return trimmed ? `${value}${value && !/\s$/.test(value) ? '\n' : ''}${trimmed}` : value;
}

// A LAN recorder cannot serve phones visiting the public TCP-forwarded site.
// Validate before opening a tab; an unreachable private URL leaves mobile
// browsers sitting on about:blank while the navigation times out.
export function getDictationPage(configuredUrl: string | undefined, pageUrl: string): URL | null {
    if (!configuredUrl?.trim()) return null;
    try {
        const target = new URL(configuredUrl);
        const page = new URL(pageUrl);
        const privateHost = (hostname: string) => {
            const host = hostname.toLowerCase();
            if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === '[::1]'
                || /^\[(?:fc|fd|fe[89ab])/.test(host)) return true;
            const parts = host.split('.').map(Number);
            if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
            return parts[0] === 10 || parts[0] === 127 || parts[0] === 0
                || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
                || (parts[0] === 192 && parts[1] === 168)
                || (parts[0] === 169 && parts[1] === 254)
                || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127);
        };
        if (target.protocol !== 'https:' || target.username || target.password) return null;
        if (privateHost(target.hostname) && !privateHost(page.hostname)) return null;
        return target;
    } catch { return null; }
}

export function isDictationMessage(event: Pick<MessageEvent, 'origin' | 'source' | 'data'>, origin: string, popup: Window | null, channel: string): boolean {
    return !!popup && event.source === popup && event.origin === origin && event.data?.type === 'hapla-asr'
        && event.data.channel === channel && typeof event.data.text === 'string' && event.data.text.length <= 64_000;
}

// AudioWorklet runs on the audio thread. Browser sample rate is resampled
// explicitly so devices ignoring the requested 16 kHz still produce valid PCM.
export const PCM_WORKLET = `class HaplaPCM extends AudioWorkletProcessor {
 constructor(){super();this.buffer=new Int16Array(512);this.position=0;this.phase=0;this.total=0;this.count=0;this.running=true;
 this.port.onmessage=({data})=>{if(data==='flush'){if(this.position)this.port.postMessage(this.buffer.slice(0,this.position).buffer);this.position=0;this.running=false;this.port.postMessage('flushed')}}}
 process(inputs){if(!this.running)return false;const samples=inputs[0]?.[0];if(!samples)return true;
 for(const sample of samples){this.total+=sample;this.count++;this.phase+=16000;if(this.phase>=sampleRate){this.phase-=sampleRate;const v=Math.max(-1,Math.min(1,this.total/this.count));this.total=0;this.count=0;this.buffer[this.position++]=Math.round(v*(v<0?32768:32767));if(this.position===512){this.port.postMessage(this.buffer.buffer,[this.buffer.buffer]);this.buffer=new Int16Array(512);this.position=0}}}return true;}}
 registerProcessor('hapla-pcm',HaplaPCM);`;
import type { Socket } from 'socket.io-client';

export type VoiceResources = {
    socket?: Socket;
    stream?: MediaStream;
    audio?: AudioContext;
    source?: MediaStreamAudioSourceNode;
    node?: AudioWorkletNode;
    output?: GainNode;
    timer?: ReturnType<typeof setTimeout>;
    flush?: () => void;
    cancelConnect?: () => void;
};

// Detach handlers before closing devices so shutdown cannot start another cleanup.
// Each asynchronous start keeps its own owner; cancellation never tears down a newer recording.
export function releaseVoiceResources(resources: VoiceResources): Promise<void> {
    clearTimeout(resources.timer);
    const flush = resources.flush; resources.flush = undefined; flush?.();
    const cancel = resources.cancelConnect; resources.cancelConnect = undefined; cancel?.();
    if (resources.node) {
        resources.node.port.onmessage = null;
        resources.node.onprocessorerror = null;
        resources.node.port.close();
        resources.node.disconnect();
    }
    resources.source?.disconnect();
    resources.output?.disconnect();
    resources.stream?.getTracks().forEach(track => track.stop());
    resources.socket?.removeAllListeners();
    resources.socket?.disconnect();
    return resources.audio?.close().catch(() => {}) ?? Promise.resolve();
}

export function voiceInputError(problem: unknown): string {
    const error = problem as { name?: string; message?: string } | null;
    if (error?.name === 'NotAllowedError') return '麦克风权限未开启，请在浏览器中允许使用麦克风后重试。';
    if (error?.name === 'NotFoundError') return '没有找到麦克风，请连接录音设备后重试。';
    if (error?.name === 'NotReadableError') return '麦克风被占用或无法启动，请关闭其他录音应用后重试。';
    return error?.message || '无法启动语音输入，请重试。';
}
