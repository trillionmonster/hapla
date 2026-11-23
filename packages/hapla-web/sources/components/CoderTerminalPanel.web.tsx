import '@xterm/xterm/css/xterm.css';
import * as React from 'react';
import { ActivityIndicator, Pressable, useWindowDimensions, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { openWorkspaceTerminal, type WorkspaceTerminal } from '@/utils/workspaceTerminal';
import { useSession } from '@/sync/storage';

import { terminalKeyHandler } from './terminalKeyboard';

const POLL_INTERVAL_MS = 60;

export default function CoderTerminalPanel(props: {
    sessionId: string;
    cwd?: string;
    onClose: () => void;
}) {
    const { theme } = useUnistyles();
    const { width, height } = useWindowDimensions();
    const compact = width <= 700;
    const hostRef = React.useRef<HTMLDivElement | null>(null);
    const terminalRef = React.useRef<import('@xterm/xterm').Terminal | null>(null);
    const typographyRef = React.useRef(theme.typography.code);
    typographyRef.current = theme.typography.code;
    const resizeTerminalRef = React.useRef<(() => void) | null>(null);
    const session = useSession(props.sessionId);
    const machineId = session?.metadata?.machineId;
    const sessionActiveRef = React.useRef(session?.active === true);
    sessionActiveRef.current = session?.active === true;
    const [status, setStatus] = React.useState<'connecting' | 'ready' | 'exited' | 'error'>('connecting');
    const [error, setError] = React.useState<string | null>(null);
    const [attempt, setAttempt] = React.useState(0);

    React.useEffect(() => {
        const host = hostRef.current;
        if (!host) return;
        setStatus('connecting');
        setError(null);

        let disposed = false;
        let pollTimer: ReturnType<typeof setTimeout> | null = null;
        let resizeTimer: ReturnType<typeof setTimeout> | null = null;
        let inputTimer: ReturnType<typeof setTimeout> | null = null;
        let inputBuffer = '';
        let inputWrites: Promise<void> = Promise.resolve();
        let resizeObserver: ResizeObserver | null = null;
        let terminal: import('@xterm/xterm').Terminal | null = null;
        let connection: WorkspaceTerminal | undefined;
        let cursor = 0;

        const flushInput = async () => {
            inputTimer = null;
            const data = inputBuffer;
            inputBuffer = '';
            if (!connection || !data || disposed) return;
            try {
                inputWrites = inputWrites.then(() => connection!.write(data));
                await inputWrites;
            } catch (nextError) {
                if (!disposed) {
                    setError(nextError instanceof Error ? nextError.message : 'Failed to write to terminal');
                    setStatus('error');
                }
            }
        };

        const poll = async () => {
            if (disposed || !connection || !terminal) return;
            try {
                const result = await connection.read(cursor);
                if (disposed) return;
                cursor = result.cursor;
                if (result.dataLost) {
                    terminal.writeln('\r\n[Some terminal output was dropped while this tab was inactive.]');
                }
                if (result.data) terminal.write(result.data);
                if (result.exited) {
                    terminal.writeln(`\r\n[Process exited with code ${result.exitCode ?? 'unknown'}]`);
                    setStatus('exited');
                    return;
                }
            } catch (nextError) {
                if (!disposed) {
                    terminal.writeln('\r\n[Terminal connection lost]');
                    setError(nextError instanceof Error ? nextError.message : 'Terminal connection lost');
                    setStatus('error');
                }
                return;
            }
            pollTimer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
        };

        void (async () => {
            try {
                const [{ Terminal }, { FitAddon }] = await Promise.all([
                    import('@xterm/xterm'),
                    import('@xterm/addon-fit'),
                ]);
                if (disposed) return;

                terminal = new Terminal({
                    cursorBlink: true,
                    cursorStyle: 'bar',
                    fontFamily: 'IBMPlexMono-Regular, ui-monospace, SFMono-Regular, Menlo, monospace',
                    fontSize: typographyRef.current.fontSize,
                    lineHeight: typographyRef.current.lineHeight / typographyRef.current.fontSize,
                    scrollback: compact ? 1800 : 5000,
                    allowProposedApi: false,
                    theme: theme.dark ? {
                        background: '#111315',
                        foreground: '#E7E9EA',
                        cursor: '#70A8D8',
                        selectionBackground: '#2E526F',
                        black: '#1A1C1E',
                        brightBlack: '#6C7278',
                    } : {
                        background: '#F5F6F7',
                        foreground: '#22272B',
                        cursor: '#286A9D',
                        selectionBackground: '#B9D6EA',
                        black: '#22272B',
                        brightBlack: '#697178',
                    },
                });
                const fitAddon = new FitAddon();
                resizeTerminalRef.current = () => {
                    if (!terminal || disposed) return;
                    fitAddon.fit();
                    void connection?.resize(terminal.cols, terminal.rows).catch(() => undefined);
                };
                terminal.loadAddon(fitAddon);
                terminal.open(host);
                terminalRef.current = terminal;
                fitAddon.fit();

                const started = await openWorkspaceTerminal({
                    sessionId: props.sessionId,
                    sessionActive: sessionActiveRef.current,
                    machineId,
                    cwd: props.cwd,
                    cols: terminal.cols,
                    rows: terminal.rows,
                });
                if (disposed) {
                    await started.close().catch(() => undefined);
                    return;
                }
                connection = started;
                setStatus('ready');
                terminal.focus();

                terminal.attachCustomKeyEventHandler?.(terminalKeyHandler(terminal, typeof navigator === 'undefined' ? undefined : navigator.clipboard));

                terminal.onData((data) => {
                    inputBuffer += data;
                    if (!inputTimer) inputTimer = setTimeout(() => void flushInput(), 12);
                });

                resizeObserver = new ResizeObserver(() => {
                    if (resizeTimer) clearTimeout(resizeTimer);
                    resizeTimer = setTimeout(() => {
                        if (!terminal || disposed || !connection) return;
                        fitAddon.fit();
                        void connection.resize(terminal.cols, terminal.rows).catch(() => undefined);
                    }, 80);
                });
                resizeObserver.observe(host);
                void poll();
            } catch (nextError) {
                if (!disposed) {
                    setError(nextError instanceof Error ? nextError.message : 'Failed to start terminal');
                    setStatus('error');
                }
            }
        })();

        return () => {
            disposed = true;
            if (pollTimer) clearTimeout(pollTimer);
            if (resizeTimer) clearTimeout(resizeTimer);
            if (inputTimer) clearTimeout(inputTimer);
            resizeObserver?.disconnect();
            terminal?.dispose();
            terminalRef.current = null;
            resizeTerminalRef.current = null;
            void connection?.close().catch(() => undefined);
        };
    }, [compact, machineId, props.sessionId, props.cwd, theme.dark, attempt]);

    React.useEffect(() => {
        const terminal = terminalRef.current;
        if (!terminal) return;
        terminal.options.fontSize = theme.typography.code.fontSize;
        terminal.options.lineHeight = theme.typography.code.lineHeight / theme.typography.code.fontSize;
        resizeTerminalRef.current?.();
    }, [theme.typography.code.fontSize, theme.typography.code.lineHeight]);

    const panelHeight = compact
        ? Math.max(220, Math.min(320, Math.round(height * (width > height ? 0.58 : 0.4))))
        : 320;

    return (
        <View style={{
            height: panelHeight,
            borderTopWidth: 1,
            borderTopColor: theme.colors.divider,
            backgroundColor: theme.dark ? '#111315' : '#F5F6F7',
        }}>
            <View style={{
                minHeight: compact ? 48 : 40,
                paddingLeft: 12,
                paddingRight: compact ? 4 : 8,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                borderBottomWidth: 1,
                borderBottomColor: theme.colors.divider,
            }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 0, flex: 1 }}>
                    {status === 'connecting' ? <ActivityIndicator size="small" color={theme.colors.textSecondary} /> : null}
                    <Text numberOfLines={1} style={{ color: theme.colors.text, fontSize: theme.typography.caption.fontSize, ...Typography.default('semiBold') }}>
                        Terminal / {props.cwd || 'Workspace'}
                    </Text>
                    {status === 'exited' || status === 'error' ? (
                        <Text style={{ color: status === 'error' ? theme.colors.textDestructive : theme.colors.textSecondary, fontSize: theme.typography.caption.fontSize }}>
                            {status === 'error' ? 'Disconnected' : 'Exited'}
                        </Text>
                    ) : null}
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    {status === 'error' || status === 'exited' ? (
                        <Pressable accessibilityRole="button" accessibilityLabel="重新连接终端" onPress={() => setAttempt(value => value + 1)} style={{ minHeight: 44, paddingHorizontal: 10, justifyContent: 'center' }}>
                            <Text style={{ color: theme.colors.text, fontSize: theme.typography.caption.fontSize }}>重新连接</Text>
                        </Pressable>
                    ) : null}
                    {compact ? (
                        <Pressable
                            accessibilityRole="button"
                            accessibilityLabel="Open terminal keyboard"
                            onPress={() => terminalRef.current?.focus()}
                            style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
                        >
                            <Ionicons name="keypad-outline" size={19} color={theme.colors.textSecondary} />
                        </Pressable>
                    ) : null}
                    <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="Close terminal"
                        onPress={props.onClose}
                        style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
                    >
                        <Ionicons name="close" size={20} color={theme.colors.textSecondary} />
                    </Pressable>
                </View>
            </View>
            {error ? (
                <View style={{ paddingHorizontal: 12, paddingVertical: 6, backgroundColor: theme.colors.surfaceHigh }}>
                    <Text selectable style={{ color: theme.colors.textDestructive, fontSize: theme.typography.caption.fontSize }} numberOfLines={2}>{error}</Text>
                </View>
            ) : null}
            <div
                ref={hostRef}
                aria-label="Interactive workspace terminal"
                style={{ flex: 1, minHeight: 0, padding: compact ? '7px 8px' : '8px 10px', overflow: 'hidden' }}
            />
        </View>
    );
}
