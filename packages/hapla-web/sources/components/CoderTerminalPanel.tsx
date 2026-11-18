import * as React from 'react';
import { ActivityIndicator, Pressable, ScrollView, TextInput, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { machineBash } from '@/sync/ops';
import { useSession } from '@/sync/storage';

type TerminalEntry = {
    id: number;
    command: string;
    output: string;
    exitCode: number;
};

export default function CoderTerminalPanel(props: {
    sessionId: string;
    cwd?: string;
    onClose: () => void;
}) {
    const { theme } = useUnistyles();
    const [command, setCommand] = React.useState('');
    const [entries, setEntries] = React.useState<TerminalEntry[]>([]);
    const [running, setRunning] = React.useState(false);
    const scrollRef = React.useRef<ScrollView>(null);
    const session = useSession(props.sessionId);
    const machineId = session?.metadata?.machineId;
    const canRun = Boolean(props.sessionId && props.cwd && command.trim() && !running);

    const run = React.useCallback(async () => {
        const nextCommand = command.trim();
        if (!props.sessionId || !props.cwd || !nextCommand || running) {
            return;
        }
        setCommand('');
        setRunning(true);
        try {
            if (!machineId) throw new Error('Workspace machine is unavailable');
            const result = await machineBash(machineId, nextCommand, props.cwd);
            setEntries((current) => [
                ...current,
                {
                    id: Date.now(),
                    command: nextCommand,
                    output: [result.stdout, result.stderr].filter(Boolean).join('\n'),
                    exitCode: result.exitCode,
                },
            ]);
            requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }));
        } finally {
            setRunning(false);
        }
    }, [command, machineId, props.cwd, props.sessionId, running]);

    return (
        <View style={{
            height: 250,
            borderTopWidth: 1,
            borderTopColor: theme.colors.divider,
            backgroundColor: theme.dark ? '#111315' : '#F5F6F7',
        }}>
            <View style={{
                height: 38,
                paddingHorizontal: 12,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                borderBottomWidth: 1,
                borderBottomColor: theme.colors.divider,
            }}>
                <Text style={{ color: theme.colors.text, fontSize: theme.typography.caption.fontSize, ...Typography.default('semiBold') }}>
                    Terminal / {props.cwd || 'No workspace'}
                </Text>
                <Pressable accessibilityLabel="Close terminal" onPress={props.onClose} hitSlop={10}>
                    <Ionicons name="close" size={18} color={theme.colors.textSecondary} />
                </Pressable>
            </View>
            <ScrollView
                ref={scrollRef}
                style={{ flex: 1 }}
                contentContainerStyle={{ padding: 12, gap: 10 }}
            >
                {entries.length === 0 ? (
                    <Text style={{ color: theme.colors.textSecondary, fontSize: theme.typography.code.fontSize, ...Typography.mono() }}>
                        Commands run on the connected Hapla machine in this session workspace.
                    </Text>
                ) : entries.map((entry) => (
                    <View key={entry.id}>
                        <Text selectable style={{ color: '#5AC8FA', fontSize: theme.typography.code.fontSize, ...Typography.mono() }}>
                            $ {entry.command}
                        </Text>
                        {entry.output ? (
                            <Text selectable style={{ color: theme.colors.text, fontSize: theme.typography.code.fontSize, lineHeight: theme.typography.code.lineHeight, ...Typography.mono() }}>
                                {entry.output}
                            </Text>
                        ) : null}
                        <Text style={{ color: entry.exitCode === 0 ? '#30D158' : '#FF453A', fontSize: theme.typography.code.fontSize, ...Typography.mono() }}>
                            exit {entry.exitCode}
                        </Text>
                    </View>
                ))}
            </ScrollView>
            <View style={{
                minHeight: 46,
                paddingHorizontal: 12,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 8,
                borderTopWidth: 1,
                borderTopColor: theme.colors.divider,
            }}>
                <Text style={{ color: '#5AC8FA', ...Typography.mono() }}>$</Text>
                <TextInput
                    value={command}
                    onChangeText={setCommand}
                    onSubmitEditing={() => void run()}
                    editable={Boolean(props.sessionId && props.cwd) && !running}
                    autoCapitalize="none"
                    autoCorrect={false}
                    placeholder="Enter command"
                    placeholderTextColor={theme.colors.textSecondary}
                    style={{ flex: 1, color: theme.colors.text, fontSize: theme.typography.code.fontSize, outlineStyle: 'none', ...Typography.mono() } as any}
                />
                <Pressable
                    accessibilityLabel="Run command"
                    disabled={!canRun}
                    onPress={() => void run()}
                    style={{ opacity: canRun ? 1 : 0.4 }}
                >
                    {running
                        ? <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                        : <Ionicons name="play" size={18} color={theme.colors.text} />}
                </Pressable>
            </View>
        </View>
    );
}
