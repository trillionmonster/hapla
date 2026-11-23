import * as React from 'react';
import { ActivityIndicator, Pressable, ScrollView, TextInput, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { useSession } from '@/sync/storage';
import { apiSocket } from '@/sync/apiSocket';
import { Text } from './StyledText';

import { deliveryLabels, type CodexFollowupControlsProps } from './codexFollowupModes';
export { deliveryLabels } from './codexFollowupModes';
export type { ComposerDelivery } from './codexFollowupModes';

export function CodexFollowupControls(props: CodexFollowupControlsProps) {
    const { theme } = useUnistyles();
    const session = useSession(props.sessionId);
    const queue = session?.agentState?.codexInputs;
    const chats = session?.agentState?.codexSideChats ?? [];
    const side = chats.find(chat => chat.id === props.sideChatId);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState('');
    const [edit, setEdit] = React.useState<{ id: string; revision: number; text: string } | null>(null);
    const action = async (method: string, params: unknown) => {
        setBusy(true); setError('');
        try { await apiSocket.sessionCommand(props.sessionId, method, params); setEdit(null); return true; }
        catch (problem) { setError(problem instanceof Error ? problem.message : '操作失败，请重试'); return false; }
        finally { setBusy(false); }
    };
    const button = (label: string, onPress: () => void, selected = false, destructive = false) => <Pressable key={label} accessibilityRole="button" accessibilityState={{ selected, disabled: busy }} disabled={busy} onPress={onPress}
        style={({ pressed }) => ({ minHeight: 32, paddingHorizontal: 9, paddingVertical: 6, borderRadius: 6, borderWidth: 1, borderColor: selected ? theme.colors.textSecondary : theme.colors.divider, backgroundColor: selected || pressed ? theme.colors.surfaceHigh : 'transparent' })}>
        <Text style={{ fontSize: 12, color: destructive ? theme.colors.textDestructive : theme.colors.text }}>{label}</Text>
    </Pressable>;
    return <View style={{ paddingHorizontal: 12, paddingTop: 6, gap: 6 }}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 5 }}>
            {(['steer', 'queue', 'btw', 'replace'] as const).map(mode => button(deliveryLabels[mode], () => props.onMode(mode), props.mode === mode, mode === 'replace'))}
            {button('新分支', () => void action('codex-thread-fork-current', {}))}
        </View>
        <Text style={{ fontSize: 11, color: theme.colors.textSecondary }}>
            {props.mode === 'btw' ? '旁问在独立对话中回答，主任务继续运行。旁聊默认只读。' : props.mode === 'queue' ? '等当前任务结束后处理；队列支持修改、排序、删除和立即发送。' : props.mode === 'replace' ? '将停止当前任务，再开始处理这条消息。' : '运行中直接补充指令，空闲时开启下一轮。Tab 可将当前输入排队。'}
        </Text>
        {!!queue?.items.length && <View style={{ borderWidth: 1, borderColor: theme.colors.divider, borderRadius: 8, padding: 8, gap: 6, backgroundColor: theme.colors.surfaceHigh }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Text style={{ flex: 1, fontSize: 12, color: theme.colors.textSecondary }}>待处理 {queue.items.length} 条{queue.paused ? ' · 已暂停' : ''}</Text>
                {button(queue.paused ? '继续队列' : '暂停队列', () => void action('codex-queue', { action: queue.paused ? 'start' : 'pause' }))}
            </View>
            <ScrollView style={{ maxHeight: 180 }}>
                {queue.items.map((item, index) => <View key={item.id} style={{ paddingVertical: 6, gap: 5 }}>
                    {edit?.id === item.id ? <TextInput multiline value={edit.text} onChangeText={text => setEdit({ ...edit, text })} style={{ color: theme.colors.text, fontSize: 13, borderWidth: 1, borderColor: theme.colors.divider, padding: 8 }} /> : <Text numberOfLines={3} style={{ fontSize: 13, color: theme.colors.text }}>{index + 1}. {item.message}</Text>}
                    {!!item.error && <Text style={{ fontSize: 12, color: theme.colors.textDestructive }}>{item.error}</Text>}
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4 }}>
                        {edit?.id === item.id ? button('保存', () => void action('codex-queue', { action: 'update', id: item.id, revision: edit.revision, text: edit.text })) : button('修改', () => setEdit({ id: item.id, revision: item.revision, text: item.message }))}
                        {button('立即发送', () => void action('codex-queue', { action: 'inject', id: item.id, revision: item.revision }))}
                        {index > 0 && button('上移', () => { const ids = queue.items.map(item => item.id); [ids[index - 1], ids[index]] = [ids[index], ids[index - 1]]; void action('codex-queue', { action: 'reorder', ids }); })}
                        {button('删除', () => void action('codex-queue', { action: 'remove', id: item.id, revision: item.revision }), false, true)}
                    </View>
                </View>)}
            </ScrollView>
        </View>}
        {(props.mode === 'btw' || chats.some(chat => chat.status === 'running')) && <View style={{ borderWidth: 1, borderColor: theme.colors.divider, borderRadius: 8, padding: 8, gap: 6, backgroundColor: theme.colors.surfaceHigh }}>
            <ScrollView horizontal contentContainerStyle={{ gap: 5 }}>
                {button('新旁问', () => { props.onSideChat(undefined); props.onMode('btw'); }, !side)}
                {chats.map(chat => button(`${chat.status === 'running' ? '◌ ' : ''}${chat.title.slice(0, 18)}`, () => { props.onSideChat(chat.id); props.onMode('btw'); }, chat.id === side?.id))}
            </ScrollView>
            {side && <>
                <ScrollView style={{ maxHeight: 260 }}>
                    {side.messages.map(message => <View key={message.id} style={{ paddingVertical: 6 }}>
                        <Text style={{ color: theme.colors.textSecondary, fontSize: 11 }}>{message.role === 'user' ? '旁问' : 'Codex'}</Text>
                        <Text selectable style={{ color: theme.colors.text, fontSize: 13, lineHeight: 20 }}>{message.text}</Text>
                    </View>)}
                </ScrollView>
                <View style={{ flexDirection: 'row', gap: 5 }}>
                    {(side.status === 'running' || side.status === 'stopping') && <ActivityIndicator size="small" />}
                    {side.status === 'running' && button('停止旁问', () => void action('codex-side-action', { action: 'stop', id: side.id }), false, true)}
                    {button('关闭旁聊', () => { void action('codex-side-action', { action: 'remove', id: side.id }).then(success => { if (success) props.onSideChat(undefined); }); })}
                </View>
                {!!side.error && <Text style={{ fontSize: 12, color: theme.colors.textDestructive }}>{side.error}</Text>}
            </>}
        </View>}
        {!!error && <Text accessibilityRole="alert" style={{ fontSize: 12, color: theme.colors.textDestructive }}>{error}</Text>}
    </View>;
}
