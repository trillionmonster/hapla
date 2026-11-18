import * as React from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { MessageMeta } from '@/sync/typesMessageMeta';
import { useConversationMessages, useSession } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { useSessionContinuation } from '@/hooks/useSessionContinuation';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';

export function AsyncQuestionView({ question, sessionId }: { question: NonNullable<MessageMeta['asyncQuestion']>; sessionId: string }) {
    const { theme } = useUnistyles();
    const session = useSession(sessionId);
    const prepareSession = useSessionContinuation(session);
    const navigate = useNavigateToSession();
    const { messages } = useConversationMessages(sessionId);
    const response = messages.find((message) => message.kind === 'user-text' && message.meta?.asyncQuestionResponse?.id === question.id)?.meta?.asyncQuestionResponse;
    const [answers, setAnswers] = React.useState(() => question.questions.map((item) => item.options?.[0] ?? ''));
    const [custom, setCustom] = React.useState<Record<number, boolean>>({});
    const [sending, setSending] = React.useState(false);
    const [sent, setSent] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const busy = React.useRef(false);
    const generation = React.useRef(0);
    React.useEffect(() => {
        generation.current++;
        setAnswers(question.questions.map((item) => item.options?.[0] ?? ''));
        setCustom({}); setSending(false); setSent(false); setError(null); busy.current = false;
        return () => { generation.current++; };
    }, [question.id, sessionId]);
    const resolved = sent || (!!response && !error);
    const updateAnswer = (index: number, value: string) => setAnswers((previous) => previous.map((answer, i) => i === index ? value : answer));
    const submit = async () => {
        if (busy.current || resolved || !answers.every((answer) => answer.trim())) return;
        const current = generation.current;
        busy.current = true; setSending(true); setError(null);
        try {
            const target = await prepareSession();
            const text = question.questions.map((item, index) => `${item.title}\n回答：${answers[index].trim()}`).join('\n\n');
            await sync.sendMessage(target, text, { source: 'question', asyncQuestionResponse: { id: question.id, answers: answers.map((answer) => answer.trim()) } });
            if (generation.current === current) {
                setSent(true);
                if (target !== sessionId) navigate(target);
            }
        } catch (failure) {
            if (generation.current === current) setError(failure instanceof Error ? `发送失败，请重试：${failure.message}` : '发送失败，请重试');
        } finally {
            if (generation.current === current) { busy.current = false; setSending(false); }
        }
    };
    return <View style={styles.card}>
        {question.questions.map((item, index) => <View key={index} style={styles.question}>
            <Text style={styles.title}>{item.title}</Text>
            {resolved ? <Text style={styles.optionText}>{response?.answers[index] ?? answers[index]}</Text> : (item.options ?? []).map((option) => <Pressable
                key={option} accessibilityRole="radio" accessibilityLabel={option}
                accessibilityState={{ checked: !custom[index] && answers[index] === option, disabled: sending || resolved }}
                aria-checked={!custom[index] && answers[index] === option} aria-disabled={sending || resolved}
                disabled={sending || resolved}
                onPress={() => { setCustom((previous) => ({ ...previous, [index]: false })); updateAnswer(index, option); }}
                style={[styles.option, !custom[index] && answers[index] === option && styles.selected]}
            ><Text style={styles.optionText}>{!custom[index] && answers[index] === option ? '●' : '○'}  {option}</Text></Pressable>)}
            {!resolved && <TextInput
                accessibilityLabel={`问题 ${index + 1} 的自定义回答`} placeholder="输入其他回答"
                placeholderTextColor={theme.colors.textSecondary} multiline editable={!sending}
                value={custom[index] || !item.options?.length ? answers[index] ?? '' : ''}
                onChangeText={(value) => { setCustom((previous) => ({ ...previous, [index]: true })); updateAnswer(index, value); }}
                style={styles.input}
            />}
        </View>)}
        {error && <Text accessibilityRole="alert" style={styles.status}>{error}</Text>}
        {sending ? <View style={styles.sending}><ActivityIndicator size="small" /><Text style={styles.status}>正在发送回答…</Text></View>
            : resolved ? <Text accessibilityLiveRegion="polite" style={styles.status}>已发送回答</Text>
            : <Pressable accessibilityRole="button" accessibilityLabel="发送回答"
                accessibilityState={{ disabled: !answers.every((answer) => answer.trim()) }}
                aria-disabled={!answers.every((answer) => answer.trim())}
                disabled={!answers.every((answer) => answer.trim())} onPress={() => void submit()}
                style={[styles.submit, !answers.every((answer) => answer.trim()) && { opacity: 0.5 }]}
            ><Text style={styles.submitText}>发送回答</Text></Pressable>}
    </View>;
}

const styles = StyleSheet.create((theme) => ({
    card: { borderWidth: 1, borderColor: theme.colors.divider, borderRadius: 12, padding: 16, gap: 16, backgroundColor: theme.colors.surfaceHigh },
    question: { gap: 8 },
    title: { color: theme.colors.text, fontSize: theme.typography.body.fontSize, lineHeight: theme.typography.body.lineHeight, fontWeight: '600', marginBottom: 4 },
    option: { borderWidth: 1, borderColor: theme.colors.divider, borderRadius: 8, padding: 12, minHeight: 44, justifyContent: 'center' },
    selected: { borderColor: theme.colors.radio.active, backgroundColor: theme.colors.surfaceHighest },
    optionText: { color: theme.colors.text, fontSize: theme.typography.label.fontSize, lineHeight: theme.typography.label.lineHeight },
    input: { color: theme.colors.text, borderWidth: 1, borderColor: theme.colors.divider, borderRadius: 8, padding: 12, minHeight: 44, fontSize: theme.typography.label.fontSize },
    submit: { backgroundColor: theme.colors.button.primary.background, borderRadius: 8, padding: 12, minHeight: 44, alignSelf: 'flex-end', justifyContent: 'center' },
    submitText: { color: theme.colors.button.primary.tint, fontWeight: '600', fontSize: theme.typography.label.fontSize },
    sending: { flexDirection: 'row', gap: 8, alignItems: 'center' },
    status: { color: theme.colors.textSecondary, fontSize: theme.typography.small.fontSize },
}));
