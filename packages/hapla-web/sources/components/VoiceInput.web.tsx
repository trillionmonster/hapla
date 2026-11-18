import * as React from 'react';
import { io } from 'socket.io-client';
import { TokenStorage } from '@/auth/tokenStorage';
import { getServerUrl } from '@/sync/serverConfig';
import { randomId } from '@/utils/randomId';
import { appendDictation, getDictationPage, isDictationMessage, PCM_WORKLET, releaseVoiceResources, voiceInputError, type VoiceResources } from '@/utils/voiceInput';
import { useUnistyles } from 'react-native-unistyles';
import type { VoiceInputFeedback, VoiceInputProps } from './VoiceInput';
export type { VoiceInputFeedback, VoiceInputProps } from './VoiceInput';

const ASR_PAGE = process.env.EXPO_PUBLIC_ASR_URL;
type Status = 'idle' | 'connecting' | 'recording' | 'stopping' | 'popup';

function MicrophoneIcon({ stop = false }: { stop?: boolean }) {
    return <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        {stop ? <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" /> : <><rect x="9" y="2" width="6" height="13" rx="3" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" /></>}
    </svg>;
}

export function VoiceInputStatus({ feedback }: { feedback: VoiceInputFeedback | null }) {
    const { theme } = useUnistyles();
    if (!feedback) return null;
    return <div role={feedback.error ? 'alert' : 'status'} style={{ margin: '6px 8px 2px', padding: '10px 12px', borderRadius: 12, background: theme.colors.surfaceSelected, color: theme.colors.text, fontSize: theme.typography.small.fontSize, lineHeight: `${theme.typography.small.lineHeight}px` }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ color: feedback.error ? theme.colors.textDestructive : theme.colors.textSecondary }}>{feedback.message}</span>
            {feedback.dismiss && <button type="button" aria-label="关闭语音提示" onClick={feedback.dismiss} style={{ border: 0, flexShrink: 0, width: 32, height: 32, padding: 4, borderRadius: 8, color: theme.colors.textSecondary, background: 'transparent', cursor: 'pointer' }}>
                <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="m6 6 12 12M18 6 6 18" /></svg>
            </button>}
        </div>
        {!!feedback.partial && <div style={{ marginTop: 4, maxHeight: 80, overflowY: 'auto', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>{feedback.partial}</div>}
        {feedback.action && <button type="button" onClick={feedback.action.onPress} style={{ marginTop: 8, minHeight: 40, padding: '8px 12px', border: `1px solid ${theme.colors.divider}`, borderRadius: 8, background: theme.colors.surface, color: theme.colors.text, fontSize: theme.typography.small.fontSize, cursor: 'pointer' }}>{feedback.action.label}</button>}
    </div>;
}

export function VoiceInput(props: VoiceInputProps) {
    const { theme } = useUnistyles();
    const current = React.useRef(props); current.current = props;
    const [status, setStatus] = React.useState<Status>('idle');
    const statusRef = React.useRef<Status>('idle');
    const changeStatus = (value: Status) => { statusRef.current = value; setStatus(value); current.current.onBusyChange?.(value !== 'idle'); };
    const [partial, setPartial] = React.useState('');
    const [error, setError] = React.useState('');
    const [needsSecurePage, setNeedsSecurePage] = React.useState(false);
    const resources = React.useRef<VoiceResources | null>(null);
    const closing = React.useRef(false);
    const popup = React.useRef<Window | null>(null);
    const channel = React.useRef('');
    const dictationPage = typeof window === 'undefined' ? null : getDictationPage(ASR_PAGE, window.location.href);
    const popupOrigin = React.useRef('');
    const commit = (text: string) => {
        const value = appendDictation(current.current.value, text);
        current.current = { ...current.current, value };
        current.current.onChangeText(value);
    };
    const cleanup = React.useCallback(() => {
        const old = resources.current; resources.current = null;
        if (old) {
            closing.current = true;
            void releaseVoiceResources(old).finally(() => { closing.current = false; });
        }
        // Closing from pagehide can close the new dictation tab on mobile.
        // The user controls the lifetime of that tab.
        popup.current = null; channel.current = ''; popupOrigin.current = '';
        statusRef.current = 'idle'; setStatus('idle'); setPartial('');
        current.current.onBusyChange?.(false);
    }, []);
    const stopPopup = () => {
        if (!popup.current || popup.current.closed) { cleanup(); return; }
        try {
            popup.current.postMessage({ type: 'hapla-asr-stop', channel: channel.current }, popupOrigin.current);
            changeStatus('stopping');
            if (resources.current) {
                clearTimeout(resources.current.timer);
                resources.current.timer = setTimeout(() => { cleanup(); setError('听写页未响应，请在听写页结束录音后返回。'); }, 30_000);
            }
        } catch (problem) { cleanup(); setError(voiceInputError(problem)); }
    };
    React.useEffect(() => {
        const hide = () => { if (!popup.current) cleanup(); };
        const listen = (event: MessageEvent) => {
            if (!isDictationMessage(event, popupOrigin.current, popup.current, channel.current)) return;
            if (event.data.final) commit(event.data.text);
            setPartial(event.data.final ? '' : event.data.text);
            if (event.data.stopped) cleanup();
        };
        window.addEventListener('pagehide', hide);
        window.addEventListener('message', listen);
        return () => {
            window.removeEventListener('pagehide', hide); window.removeEventListener('message', listen);
            if (popup.current && !popup.current.closed) {
                try { popup.current.postMessage({ type: 'hapla-asr-stop', channel: channel.current }, popupOrigin.current); } catch {}
            }
            cleanup(); current.current.onFeedbackChange?.(null); setError(''); setNeedsSecurePage(false);
        };
    }, [props.scope, cleanup]);

    const openDictationPage = () => {
        if (statusRef.current !== 'idle') return;
        try {
            const url = getDictationPage(ASR_PAGE, window.location.href);
            if (!url) throw new Error('当前页面需要使用 HTTPS 才能录音。');
            const id = randomId();
            url.hash = new URLSearchParams({ haplaOrigin: window.location.origin, haplaChannel: id }).toString();
            const opened = window.open(url.toString(), '_blank');
            if (!opened) throw new Error('浏览器阻止了听写页，请允许打开新窗口后重试。');
            popup.current = opened; popupOrigin.current = url.origin; channel.current = id; setNeedsSecurePage(false); setError(''); changeStatus('popup');
            resources.current = { timer: setInterval(() => { if (opened.closed) cleanup(); }, 1000) };
        } catch (problem) { setError(voiceInputError(problem)); }
    };

    React.useEffect(() => {
        const message = error || (needsSecurePage ? (dictationPage
            ? '当前页面使用 HTTP，浏览器不允许录音。可在听写页录音，文字会自动填回这里。'
            : '当前页面使用 HTTP，浏览器不允许录音。请使用本站的 HTTPS 地址，也可以用手机键盘上的语音输入。')
            : status === 'connecting' ? '正在连接语音服务…再次点击麦克风可取消。'
            : status === 'recording' ? '正在听写，点击停止后可编辑并发送。'
            : status === 'stopping' ? '正在完成最后一句…'
            : status === 'popup' ? '在听写页开始录音，结束后返回这里编辑文字。' : '');
        current.current.onFeedbackChange?.(message ? {
            message, partial, error: !!error,
            ...(needsSecurePage && dictationPage ? { action: { label: '打开听写页', onPress: openDictationPage } } : {}),
            ...(status === 'idle' ? { dismiss: () => { setError(''); setNeedsSecurePage(false); } } : {}),
        } : null);
    }, [status, partial, error, needsSecurePage]);

    const start = async () => {
        if (statusRef.current !== 'idle' || closing.current) return;
        setError('');
        if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) { setNeedsSecurePage(true); return; }
        if (!window.AudioContext || !window.AudioWorkletNode) { setError('当前浏览器不支持语音输入，请使用支持录音的浏览器。'); return; }
        setNeedsSecurePage(false);
        // Block repeated taps before React has rendered the new status.
        changeStatus('connecting');
        const owned: VoiceResources = {}; resources.current = owned;
        const active = () => resources.current === owned;
        try {
            // Keep the native device rate; the worklet resamples to 16 kHz.
            const audio = new AudioContext(); owned.audio = audio;
            if (!audio.audioWorklet) throw new Error('当前浏览器不支持语音输入。');
            await audio.resume(); if (!active()) return;
            const credentials = await TokenStorage.getCredentials(); if (!active()) return;
            if (!credentials) throw new Error('请先登录后使用语音输入。');
            const socket = io(`${getServerUrl().replace(/\/$/, '')}/asr`, { path: '/v1/updates', auth: { token: credentials.token, clientType: 'user-scoped' }, transports: ['websocket'], reconnection: false });
            owned.socket = socket;
            await new Promise<void>((resolve, reject) => {
                owned.cancelConnect = () => reject(new Error('语音连接已取消'));
                owned.timer = setTimeout(() => reject(new Error('语音服务连接超时，请稍后重试。')), 15_000);
                socket.on('connect', () => socket.emit('asr-start'));
                socket.on('connect_error', () => reject(new Error('无法连接语音服务，请稍后重试。')));
                socket.on('asr-event', event => {
                    if (!active()) return;
                    if (event.type === 'ready') { clearTimeout(owned.timer); owned.cancelConnect = undefined; resolve(); }
                    else if (event.type === 'partial') setPartial(event.text || '');
                    else if (event.type === 'final') { commit(event.text || ''); setPartial(''); }
                    else if (event.type === 'stopped') cleanup();
                    else if (event.type === 'error') { reject(new Error(event.message)); cleanup(); setError(event.message || '语音服务发生错误。'); }
                });
                socket.on('disconnect', () => { if (active()) { reject(new Error('语音连接断开')); cleanup(); setError('语音连接断开，已保留完成的文字。'); } });
            });
            if (!active()) return;
            owned.timer = setTimeout(() => { if (active()) { cleanup(); setError('麦克风启动超时，请重试。'); } }, 30_000);
            const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
            if (!active()) { stream.getTracks().forEach(track => track.stop()); return; }
            owned.stream = stream;
            const blobUrl = URL.createObjectURL(new Blob([PCM_WORKLET], { type: 'application/javascript' }));
            try { await audio.audioWorklet.addModule(blobUrl); } finally { URL.revokeObjectURL(blobUrl); }
            if (!active()) return;
            const source = audio.createMediaStreamSource(stream);
            const node = new AudioWorkletNode(audio, 'hapla-pcm');
            const output = audio.createGain(); output.gain.value = 0;
            owned.source = source; owned.node = node; owned.output = output;
            node.port.onmessage = ({ data }) => {
                if (!active()) return;
                if (data === 'flushed') { owned.flush?.(); return; }
                if ((socket.io.engine?.writeBuffer.length ?? 0) > 128) { cleanup(); setError('音频发送积压，请检查网络后重新录音。'); return; }
                if (socket.connected) socket.emit('asr-pcm', data);
            };
            node.onprocessorerror = () => { if (active()) { cleanup(); setError('录音处理中断，已保留完成的文字。'); } };
            source.connect(node); node.connect(output); output.connect(audio.destination);
            clearTimeout(owned.timer); changeStatus('recording');
        } catch (problem) {
            if (active()) { cleanup(); setError(voiceInputError(problem)); }
        }
    };
    const stop = async () => {
        const state = statusRef.current;
        if (state === 'popup') { stopPopup(); return; }
        if (state === 'connecting') { cleanup(); return; }
        if (state !== 'recording') return;
        changeStatus('stopping');
        const old = resources.current;
        if (!old) { cleanup(); return; }
        await new Promise<void>(resolve => { const timer = setTimeout(resolve, 1000); old.flush = () => { clearTimeout(timer); old.flush = undefined; resolve(); }; old.node?.port.postMessage('flush'); });
        if (resources.current !== old) return;
        old.stream?.getTracks().forEach(track => track.stop());
        old.socket?.emit('asr-stop');
        old.timer = setTimeout(() => { cleanup(); setError('最后一句转写超时，已保留完成的文字。'); }, 30_000);
    };
    const active = status !== 'idle';
    return <button type="button" aria-label={active ? '停止语音输入' : '语音输入'} aria-pressed={active} title={active ? '停止语音输入' : '语音输入'} disabled={status === 'stopping'}
        onClick={() => { void (active ? stop() : start()).catch(problem => { cleanup(); setError(voiceInputError(problem)); }); }}
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, width: 44, height: 44, padding: 8, border: 0, borderRadius: 16, color: active ? theme.colors.textDestructive : theme.colors.button.secondary.tint, background: active ? theme.colors.surfaceSelected : 'transparent', cursor: status === 'stopping' ? 'wait' : 'pointer', opacity: status === 'stopping' ? 0.6 : 1 }}>
        <MicrophoneIcon stop={active} />
    </button>;
}
