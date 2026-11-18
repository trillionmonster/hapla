import * as React from 'react';
import { Modal, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { useIsFocused } from '@react-navigation/native';
import { apiSocket } from '@/sync/apiSocket';
import { sync } from '@/sync/sync';
import { decryptProtocolPage, protocolChunkPreview, readBoundedProtocolResponse, type ProtocolCursor, type ProtocolDiagnosticChunk, type ProtocolEpoch } from '@/sync/protocolDiagnostics';
import type { Machine, Session } from '@/sync/storageTypes';
import { buildCodexDiagnosticSummary } from '@/utils/codexDiagnosticSummary';

const FIRST: ProtocolCursor = { after_seq: 0, after_part: -1 };

/** Explicit diagnostics surface. Current page only; never feeds raw provider data into messages. */
export function CodexProtocolDiagnostics({
    session,
    machine,
    socketStatus,
}: {
    session: Session;
    machine: Machine | null;
    socketStatus: string;
}) {
    const sessionId = session.id;
    const { theme } = useUnistyles();
    const isFocused = useIsFocused();
    const [visible, setVisible] = React.useState(false);
    const [epochs, setEpochs] = React.useState<ProtocolEpoch[]>([]);
    const [epochCursor, setEpochCursor] = React.useState<{ before_at: number; before_epoch: string } | null>(null);
    const [epoch, setEpoch] = React.useState('');
    const [epochOwner, setEpochOwner] = React.useState('');
    const [chunks, setChunks] = React.useState<ProtocolDiagnosticChunk[]>([]);
    const [cursor, setCursor] = React.useState(FIRST);
    const [next, setNext] = React.useState(FIRST);
    const [hasMore, setHasMore] = React.useState(false);
    const [seek, setSeek] = React.useState('1');
    const [selected, setSelected] = React.useState<string | null>(null);
    const [error, setError] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    const summary = React.useMemo(
        () => buildCodexDiagnosticSummary(session, machine, socketStatus),
        [session, machine, socketStatus],
    );
    const generation = React.useRef(0);
    const activeRequest = React.useRef<AbortController | null>(null);
    const stop = React.useCallback(() => { generation.current++; activeRequest.current?.abort(); activeRequest.current = null; }, []);
    const begin = React.useCallback(() => {
        stop();
        const controller = new AbortController();
        activeRequest.current = controller;
        setBusy(true); setError('');
        return { controller, current: generation.current };
    }, [stop]);
    const loadEpochs = React.useCallback(async (older?: { before_at: number; before_epoch: string }) => {
        const { controller, current } = begin();
        try {
            const query = older ? `?before_at=${older.before_at}&before_epoch=${encodeURIComponent(older.before_epoch)}` : '';
            const response = await apiSocket.request(`/v1/sessions/${encodeURIComponent(sessionId)}/protocol/epochs${query}`, { signal: controller.signal });
            const page = await readBoundedProtocolResponse(response) as { epochs: ProtocolEpoch[]; nextCursor: typeof epochCursor };
            if (current !== generation.current) return;
            if (!Array.isArray(page.epochs) || page.epochs.length > 20) throw new Error('无效的协议日志 epoch 页面');
            setEpochs(page.epochs); setEpochCursor(page.nextCursor); setEpoch(page.epochs[0]?.epoch ?? ''); setEpochOwner(sessionId);
            setCursor(FIRST); setChunks([]); setSelected(null);
        } catch (failure) { if (current === generation.current) setError(failure instanceof Error ? failure.message : '读取失败'); }
        finally { if (current === generation.current) setBusy(false); }
    }, [sessionId, begin]);
    const loadPage = React.useCallback(async (target: ProtocolCursor) => {
        if (!epoch || epochOwner !== sessionId) return;
        const { controller, current } = begin();
        setSelected(null); setChunks([]);
        try {
            const encryption = sync.encryption.getSessionEncryption(sessionId);
            if (!encryption) throw new Error('会话密钥尚未就绪');
            const response = await apiSocket.request(`/v1/sessions/${encodeURIComponent(sessionId)}/protocol/${encodeURIComponent(epoch)}/chunks?after_seq=${target.after_seq}&after_part=${target.after_part}`, { signal: controller.signal });
            const page = await decryptProtocolPage(await readBoundedProtocolResponse(response), sessionId, epoch, value => encryption.decryptRaw(value));
            if (current !== generation.current || sync.encryption.getSessionEncryption(sessionId) !== encryption) return;
            setChunks(page.chunks); setCursor(target); setNext(page.cursor); setHasMore(page.hasMore);
        } catch (failure) { if (current === generation.current) setError(failure instanceof Error ? failure.message : '读取失败'); }
        finally { if (current === generation.current) setBusy(false); }
    }, [sessionId, epoch, epochOwner, begin]);
    React.useEffect(() => {
        if (visible) { setChunks([]); setEpochs([]); void loadEpochs(); }
        return stop;
    }, [visible, sessionId, loadEpochs, stop]);
    React.useEffect(() => { if (visible && epoch) void loadPage(FIRST); }, [visible, epoch, loadPage]);
    const close = () => { stop(); setVisible(false); setChunks([]); setEpochs([]); setEpoch(''); setEpochOwner(''); setError(''); };
    React.useEffect(() => {
        if (!isFocused) { stop(); setVisible(false); setChunks([]); setEpochs([]); setEpoch(''); setEpochOwner(''); setSelected(null); }
    }, [isFocused, stop]);
    const button = (label: string, action: () => void, disabled = false) => (
        <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={action} disabled={disabled} style={{ padding: 10, opacity: disabled ? 0.4 : 1 }}>
            <Text style={{ color: theme.colors.text }}>{label}</Text>
        </Pressable>
    );
    return <>
        {button('协议诊断', () => setVisible(true))}
        <Modal visible={visible} transparent animationType="fade" onRequestClose={close}>
            <View style={{ flex: 1, padding: 20, backgroundColor: 'rgba(0,0,0,0.35)', alignItems: 'center', justifyContent: 'center' }}>
                <View style={{ width: '100%', maxWidth: 960, height: '90%', backgroundColor: theme.colors.surface, borderRadius: 14, padding: 16 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                        <Text style={{ fontSize: theme.typography.subheading.fontSize, color: theme.colors.text }}>Codex 协议诊断</Text>
                        {button('关闭诊断', close)}
                    </View>
                    <Text style={{ color: theme.colors.textSecondary }}>独立加密原始日志。每页最多 256 KiB；大记录按字节分片查看。</Text>
                    <View accessibilityLabel="Codex 状态摘要" style={{ marginVertical: 8, borderColor: theme.colors.divider, borderWidth: 1, borderRadius: 8, padding: 8 }}>
                        {summary.map(row => <View key={row.label} style={{ flexDirection: 'row', paddingVertical: 2 }}>
                            <Text style={{ width: 130, color: theme.colors.textSecondary, fontSize: theme.typography.caption.fontSize }}>{row.label}</Text>
                            <Text selectable style={{ flex: 1, color: theme.colors.text, fontFamily: 'monospace', fontSize: theme.typography.code.fontSize }}>{row.value}</Text>
                        </View>)}
                    </View>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
                        {epochs.map(item => <React.Fragment key={item.epoch}>{button(`${epoch === item.epoch ? '● ' : ''}${new Date(item.epochStartedAt).toLocaleString()} · ${item.epoch.slice(0, 8)}`, () => { setEpoch(item.epoch); setCursor(FIRST); }, busy)}</React.Fragment>)}
                        {epochCursor ? button('更早连接', () => { void loadEpochs(epochCursor); }, busy) : null}
                    </View>
                    <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' }}>
                        <Text style={{ color: theme.colors.textSecondary }}>事件序号</Text>
                        <TextInput accessibilityLabel="诊断事件序号" value={seek} onChangeText={setSeek} keyboardType="numeric" style={{ color: theme.colors.text, borderColor: theme.colors.divider, borderWidth: 1, padding: 6, marginLeft: 8, width: 100 }} />
                        {button('跳转', () => { const seq = Number(seek); if (Number.isInteger(seq) && seq >= 1 && seq <= 2_147_483_647) void loadPage({ after_seq: seq, after_part: -1 }); }, busy || !epoch)}
                        {button('刷新本页', () => { void loadPage(cursor); }, busy || !epoch)}
                        {button('下一页', () => { void loadPage(next); }, busy || !hasMore)}
                    </View>
                    {busy ? <Text style={{ color: theme.colors.textSecondary }}>正在读取…</Text> : null}
                    {error ? <Text accessibilityRole="alert" style={{ color: theme.colors.text }}>{error}</Text> : null}
                    {!busy && !error && !chunks.length ? <Text style={{ color: theme.colors.textSecondary }}>暂无已上传的协议记录。</Text> : null}
                    <ScrollView style={{ flex: 1 }}>
                        {chunks.map(chunk => {
                            const id = `${chunk.seq}:${chunk.part}`;
                            return <View key={id} style={{ borderBottomColor: theme.colors.divider, borderBottomWidth: 1, paddingVertical: 6 }}>
                                {button(`#${chunk.seq} · ${chunk.summary.direction} · ${chunk.summary.method ?? chunk.summary.kind} · 分片 ${chunk.part + 1}/${chunk.parts}`, () => setSelected(selected === id ? null : id))}
                                {selected === id ? <View>
                                    <Text selectable style={{ fontFamily: 'monospace', fontSize: theme.typography.code.fontSize, color: theme.colors.textSecondary }}>{JSON.stringify(chunk.summary.protocol)}</Text>
                                    <Text selectable style={{ fontFamily: 'monospace', fontSize: theme.typography.code.fontSize, color: theme.colors.text }}>{protocolChunkPreview(chunk)}</Text>
                                </View> : null}
                            </View>;
                        })}
                    </ScrollView>
                </View>
            </View>
        </Modal>
    </>;
}
