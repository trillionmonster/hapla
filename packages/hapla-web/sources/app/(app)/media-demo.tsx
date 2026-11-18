import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { MediaGallery } from '@/components/media/MediaGallery';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';

const wideSvg = `data:image/svg+xml,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="520" viewBox="0 0 1600 520">
  <defs><linearGradient id="g" x1="0" x2="1"><stop stop-color="#0c7785"/><stop offset="1" stop-color="#635bff"/></linearGradient></defs>
  <rect width="1600" height="520" fill="#0d1117"/><rect x="40" y="40" width="1520" height="440" rx="36" fill="url(#g)"/>
  <text x="90" y="235" fill="white" font-size="72" font-family="sans-serif" font-weight="700">1600 × 520 宽图</text>
  <text x="90" y="325" fill="#dcecff" font-size="38" font-family="sans-serif">完整比例，不裁切，不制造固定 16:9 空白</text>
</svg>`)} `;

const tallSvg = `data:image/svg+xml,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" width="520" height="1200" viewBox="0 0 520 1200">
  <rect width="520" height="1200" fill="#11161c"/><circle cx="260" cy="260" r="180" fill="#e05a47"/>
  <text x="260" y="610" text-anchor="middle" fill="white" font-size="52" font-family="sans-serif" font-weight="700">竖图</text>
  <text x="260" y="680" text-anchor="middle" fill="#b9c7d5" font-size="28" font-family="sans-serif">520 × 1200</text>
</svg>`)} `;

function toneWavDataUrl(): string {
    const sampleRate = 8000;
    const sampleCount = sampleRate * 2;
    const bytes = new Uint8Array(44 + sampleCount * 2);
    const view = new DataView(bytes.buffer);
    const text = (offset: number, value: string) => [...value].forEach((character, index) => view.setUint8(offset + index, character.charCodeAt(0)));
    text(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); text(8, 'WAVE'); text(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    text(36, 'data'); view.setUint32(40, sampleCount * 2, true);
    for (let index = 0; index < sampleCount; index += 1) {
        const envelope = Math.min(1, index / 300) * Math.min(1, (sampleCount - index) / 600);
        view.setInt16(44 + index * 2, Math.sin(index / sampleRate * Math.PI * 2 * 440) * 9000 * envelope, true);
    }
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    return `data:audio/wav;base64,${btoa(binary)}`;
}

function useGeneratedWebm(): { url: string | null; error: string | null } {
    const [result, setResult] = React.useState<{ url: string | null; error: string | null }>({ url: null, error: null });
    React.useEffect(() => {
        let cancelled = false;
        let objectUrl: string | null = null;
        void (async () => {
            try {
                const canvas = document.createElement('canvas');
                canvas.width = 640;
                canvas.height = 360;
                const context = canvas.getContext('2d');
                if (!context || !canvas.captureStream || typeof MediaRecorder === 'undefined') throw new Error('当前浏览器不能生成 WebM 验收样例');
                const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((type) => MediaRecorder.isTypeSupported(type));
                if (!mimeType) throw new Error('当前浏览器没有 WebM 编码器');
                const recorder = new MediaRecorder(canvas.captureStream(12), { mimeType });
                const chunks: Blob[] = [];
                recorder.ondataavailable = (event) => { if (event.data.size > 0) chunks.push(event.data); };
                const stopped = new Promise<void>((resolve) => { recorder.onstop = () => resolve(); });
                recorder.start();
                for (let frame = 0; frame < 24 && !cancelled; frame += 1) {
                    const hue = (frame * 13) % 360;
                    context.fillStyle = `hsl(${hue} 55% 16%)`;
                    context.fillRect(0, 0, canvas.width, canvas.height);
                    context.fillStyle = '#ffffff';
                    context.font = '700 42px sans-serif';
                    context.fillText('Hapla WebM streaming demo', 38, 165);
                    context.font = '24px sans-serif';
                    context.fillStyle = '#c8d8e8';
                    context.fillText(`frame ${frame + 1} / 24`, 38, 215);
                    await new Promise((resolve) => window.setTimeout(resolve, 70));
                }
                recorder.stop();
                await stopped;
                if (cancelled) return;
                objectUrl = URL.createObjectURL(new Blob(chunks, { type: mimeType }));
                setResult({ url: objectUrl, error: null });
            } catch (error) {
                if (!cancelled) setResult({ url: null, error: error instanceof Error ? error.message : '无法生成 WebM 样例' });
            }
        })();
        return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
    }, []);
    return result;
}

export default function MediaDemo() {
    const generatedVideo = useGeneratedWebm();
    const audioUrl = React.useMemo(toneWavDataUrl, []);
    return (
        <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
            <Text style={styles.title}>多模态工作台验收样例</Text>
            <Text style={styles.lead}>这是实际消息媒体组件，不是静态效果图。可检查移动端比例、全屏缩放、播放、进度拖动、下载、错误提示和资源释放。</Text>

            <View style={styles.section}>
                <Text style={styles.sectionTitle}>图片比例与画廊</Text>
                <MediaGallery media={[
                    { url: wideSvg.trim(), mediaType: 'image/svg+xml', name: 'wide-1600x520.svg' },
                    { url: tallSvg.trim(), mediaType: 'image/svg+xml', name: 'tall-520x1200.svg' },
                ]} />
            </View>

            <View style={styles.section}>
                <Text style={styles.sectionTitle}>Range 友好的视频与音频</Text>
                <Text style={styles.note}>播放后拖动原生进度条。服务端同源文件会按 Range 返回 206；这里使用浏览器现场生成的 WebM 和 WAV，不依赖外网。</Text>
                <MediaGallery media={[
                    ...(generatedVideo.url ? [{ url: generatedVideo.url, mediaType: 'video/webm', name: 'generated-vp8-vp9.webm' }] : []),
                    { url: audioUrl, mediaType: 'audio/wav', name: 'generated-440hz.wav' },
                ]} />
                {!generatedVideo.url ? <Text style={styles.note}>{generatedVideo.error || '正在生成本地 WebM 样例…'}</Text> : null}
            </View>

            <View style={styles.section}>
                <Text style={styles.sectionTitle}>失败与兼容提示</Text>
                <MediaGallery media={[
                    { url: 'data:video/mp4;base64,AAAA', mediaType: 'video/mp4', name: 'damaged-video.mp4' },
                ]} />
            </View>

            <Text style={styles.footnote}>基线格式：PNG、JPEG、GIF、WebP、H.264/AAC MP4、VP9/Opus WebM、MP3、WAV、AAC/M4A、Ogg/Opus。其他格式按浏览器能力尽力支持。</Text>
        </ScrollView>
    );
}

const styles = StyleSheet.create((theme) => ({
    screen: { flex: 1, backgroundColor: theme.colors.surface },
    content: { width: '100%', maxWidth: 960, alignSelf: 'center', paddingHorizontal: 16, paddingTop: 24, paddingBottom: 64, gap: 22 },
    title: { color: theme.colors.text, fontSize: theme.typography.title.fontSize, ...Typography.default('semiBold') },
    lead: { color: theme.colors.textSecondary, fontSize: theme.typography.label.fontSize, lineHeight: theme.typography.label.lineHeight, ...Typography.default() },
    section: { width: '100%', gap: 10 },
    sectionTitle: { color: theme.colors.text, fontSize: theme.typography.body.fontSize, ...Typography.default('semiBold') },
    note: { color: theme.colors.textSecondary, fontSize: theme.typography.caption.fontSize, lineHeight: theme.typography.caption.lineHeight, ...Typography.default() },
    footnote: { color: theme.colors.textSecondary, fontSize: theme.typography.caption.fontSize, lineHeight: theme.typography.caption.lineHeight, ...Typography.default() },
}));
