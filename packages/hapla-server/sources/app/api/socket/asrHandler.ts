import WebSocket from 'ws';
import type { Server, Socket } from 'socket.io';
import { authenticateSocket } from './authenticateSocket';

export function asrUpstreamUrl(value = process.env.HAPLA_ASR_URL): string {
    if (!value?.trim()) throw new Error('ASR URL is not configured');
    const url = new URL(value);
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid ASR URL');
    url.protocol = ['https:', 'wss:'].includes(url.protocol) ? 'wss:' : 'ws:';
    url.pathname = `${url.pathname.replace(/\/$/, '')}/ws`;
    url.search = ''; url.hash = '';
    return url.toString();
}

export function attachAsrSocket(socket: Socket, createUpstream = (url: string) => new WebSocket(url, { handshakeTimeout: 10_000, maxPayload: 256 * 1024 })) {
    let upstream: WebSocket | undefined;
    let ready = false;
    let idle: ReturnType<typeof setTimeout> | undefined;
    const close = () => {
        clearTimeout(idle); ready = false;
        const old = upstream; upstream = undefined;
        if (old && old.readyState !== WebSocket.CLOSED) old.terminate();
    };
    const fail = (message: string) => { socket.emit('asr-event', { type: 'error', message }); close(); };
    const resetIdle = () => { clearTimeout(idle); idle = setTimeout(() => fail('语音连接超时，请重新录音'), 35_000); };
    socket.on('asr-start', () => {
        if (upstream) { fail('已有录音正在进行'); return; }
        try { upstream = createUpstream(asrUpstreamUrl()); } catch { fail('语音服务配置无效'); return; }
        const connection = upstream;
        resetIdle();
        connection.on('open', () => {
            // Programmatic upstream deliberately has no Origin header: the ASR
            // service accepts this trusted relay without weakening its browser check.
            connection.send(JSON.stringify({ type: 'start', sample_rate: 16000, silence_ms: 700, vad_threshold: 0.5, chunk_sec: 1, language: 'Chinese', context: '' }));
        });
        connection.on('message', (data) => {
            if (upstream !== connection) return;
            try {
                const event = JSON.parse(data.toString());
                if (event.type === 'ready') ready = true;
                socket.emit('asr-event', event);
                if (event.type === 'stopped' || event.type === 'error') close();
            } catch { fail('语音服务返回了无效数据'); }
        });
        connection.on('error', () => { if (upstream === connection) fail('无法连接本机语音服务，请检查宿主机 ASR'); });
        connection.on('close', () => { if (upstream === connection) fail('语音连接已断开，已保留完成的文字'); });
    });
    socket.on('asr-pcm', (data: unknown) => {
        if (!ready || !upstream) return;
        if (!Buffer.isBuffer(data) || !data.length || data.length % 2 || data.length > 32768) { fail('无效的录音数据'); return; }
        if (upstream.bufferedAmount > 256 * 1024) { fail('语音网络过慢，请重新录音'); return; }
        resetIdle(); upstream.send(data);
    });
    socket.on('asr-stop', () => { if (ready && upstream) { upstream.send(JSON.stringify({ type: 'stop' })); resetIdle(); } });
    socket.on('disconnect', close);
}

export function startAsrNamespace(io: Server) {
    const namespace = io.of('/asr');
    namespace.use(authenticateSocket);
    namespace.on('connection', socket => attachAsrSocket(socket));
}
