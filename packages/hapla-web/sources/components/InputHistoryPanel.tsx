import * as React from 'react';
import { ActivityIndicator, Pressable, TextInput, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Text } from './StyledText';
import { sync } from '@/sync/sync';
import { useConversationSessionIds, useSession } from '@/sync/storage';
import { LATEST_HISTORY_CURSOR, type ConversationHistoryCursor } from '@/sync/sessionHistory';
import { createReducer, reducer } from '@/sync/reducer/reducer';
import { filterMessagesForActiveBranch } from '@/utils/sessionBranches';

/** Read all question pages independently of the bounded live message window. */
export function InputHistoryPanel(props: { sessionId: string; recent: readonly string[]; onSelect: (text: string) => void }) {
    const { theme } = useUnistyles();
    const ids = useConversationSessionIds(props.sessionId);
    const session = useSession(props.sessionId);
    const [entries, setEntries] = React.useState<Array<{ id: string; text: string; at: number }>>([]);
    const [cursor, setCursor] = React.useState<ConversationHistoryCursor | null | undefined>();
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState('');
    const [query, setQuery] = React.useState('');
    const generation = React.useRef(0);
    const pending = React.useRef(false);
    const load = React.useCallback(async (start?: ConversationHistoryCursor) => {
        if (pending.current || !ids.length) return;
        const version = generation.current;
        pending.current = true; setBusy(true); setError('');
        try {
            let next: ConversationHistoryCursor | null = start ?? { sessionId: ids[0], before: LATEST_HISTORY_CURSOR };
            const added: Array<{ id: string; text: string; at: number }> = [];
            // Tool-dense pages can have no questions. Scan until a useful page
            // is full, while allowing the panel to cancel the scan on close.
            while (next && added.length < 25 && version === generation.current) {
                const page = await sync.readConversationHistoryPage(ids, next);
                const userRecords = page.messages.filter(message => message.role === 'user');
                const decoded = reducer(createReducer(), userRecords).messages;
                const messages = filterMessagesForActiveBranch(decoded, session?.metadata ?? null);
                for (const message of messages) if (message.kind === 'user-text' && message.text.trim()) added.push({ id: `${page.sessionId}:${message.id}`, text: message.displayText ?? message.text, at: message.createdAt });
                next = page.next;
            }
            if (version !== generation.current) return;
            setEntries(previous => [...new Map([...previous, ...added].map(entry => [entry.id, entry])).values()].sort((a, b) => b.at - a.at));
            setCursor(next);
        } catch (problem) { if (version === generation.current) setError(problem instanceof Error ? problem.message : '历史问题加载失败'); }
        finally { if (version === generation.current) { pending.current = false; setBusy(false); } }
    }, [ids, session?.metadata]);
    React.useEffect(() => {
        generation.current++; pending.current = false; setEntries([]); setCursor(undefined);
        void load();
        return () => { generation.current++; pending.current = false; };
    }, [props.sessionId, session?.metadata?.activeCodexBranchId]);
    const shown = entries.filter(entry => entry.text.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
    return <View style={{ padding: 10, gap: 6 }}>
        <Text style={{ fontSize: 12, color: theme.colors.textSecondary }}>当前会话的问题 · {entries.length}{cursor !== null ? '+' : ''}</Text>
        <TextInput accessibilityLabel="筛选已加载的历史问题" placeholder="筛选已加载的问题" value={query} onChangeText={setQuery}
            style={{ fontSize: 13, color: theme.colors.text, borderWidth: 1, borderColor: theme.colors.divider, borderRadius: 6, padding: 8 }} />
        {(entries.length ? shown.map(entry => ({ ...entry, key: entry.id })) : props.recent.map((text, index) => ({ key: `recent:${index}`, text, at: 0 }))).map(entry => <Pressable key={entry.key} accessibilityRole="button" onPress={() => props.onSelect(entry.text)}
            style={({ pressed }) => ({ padding: 8, borderRadius: 5, backgroundColor: pressed ? theme.colors.surfacePressed : 'transparent' })}>
            <Text numberOfLines={3} style={{ fontSize: 13, lineHeight: 19, color: theme.colors.text }}>{entry.text}</Text>
            {entry.at > 0 && <Text style={{ fontSize: 11, marginTop: 3, color: theme.colors.textSecondary }}>{new Date(entry.at).toLocaleString()}</Text>}
        </Pressable>)}
        {!!error && <Text accessibilityRole="alert" style={{ color: theme.colors.textDestructive, fontSize: 12 }}>{error}</Text>}
        {busy ? <ActivityIndicator size="small" /> : cursor !== null && <Pressable accessibilityRole="button" onPress={() => void load(cursor ?? undefined)} style={{ padding: 10 }}>
            <Text style={{ fontSize: 13, color: theme.colors.text }}>{error ? '重试加载' : '加载更早的问题'}</Text>
        </Pressable>}
        {!busy && cursor === null && <Text style={{ fontSize: 11, color: theme.colors.textSecondary }}>已加载本会话全部问题</Text>}
    </View>;
}
