import * as React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { ToolSectionView } from '../ToolSectionView';
import { CommandView } from '@/components/CommandView';
import { stringifyToolCommand } from '@/utils/toolCommand';
import { commandStatus } from '@/utils/commandStatus';
import { commandOutputPreview } from '@/utils/commandOutput';
import { downloadWorkspaceFile } from '@/utils/workspaceFileTransfer';
import { Modal } from '@/modal';
import type { ToolViewProps } from './_all';

export const CodexBashView = React.memo<ToolViewProps>(({ tool, sessionId }) => {
    const [progress, setProgress] = React.useState<number | null>(null);
    const result = tool.result && typeof tool.result === 'object' ? tool.result : {};
    const stdout = commandOutputPreview(result.stdout ?? result.output ?? (typeof tool.result === 'string' ? tool.result : ''));
    const stderr = commandOutputPreview(result.stderr);
    const command = stringifyToolCommand(result.command ?? tool.input?.command) ?? '';
    const cwd = typeof result.cwd === 'string' ? result.cwd : tool.input?.cwd;
    const logPath = typeof result.logPath === 'string' ? result.logPath : null;
    const running = tool.state === 'running';
    const details = [commandStatus(tool),
        typeof result.durationMs === 'number' ? `${(result.durationMs / 1000).toFixed(2)} 秒` : null,
    ].filter(Boolean).join(' · ');
    const truncated = stdout.truncated || stderr.truncated || result.truncated || result.outputTruncated;

    const download = async () => {
        if (!sessionId || !logPath || progress !== null) return;
        setProgress(0);
        try {
            await downloadWorkspaceFile({ sessionId, path: logPath, onProgress: setProgress });
        } catch (error) {
            if (!(error instanceof Error && error.name === 'AbortError')) Modal.alert('日志下载失败', error instanceof Error ? error.message : '无法下载日志');
        } finally {
            setProgress(null);
        }
    };

    return (
        <ToolSectionView>
            <View style={styles.container}>
                <Text style={styles.meta}>{details}</Text>
                {result.interruptionDidNotTerminateCommand === true && <Text style={styles.meta}>当时的中断未终止此命令；这里显示随后实际退出的结果。</Text>}
                {typeof cwd === 'string' && <Text selectable style={styles.meta}>工作目录：{cwd}</Text>}
                <ScrollView style={styles.output} nestedScrollEnabled>
                    <CommandView command={command} stdout={stdout.text} stderr={stderr.text} hideEmptyOutput={running || result.status === 'interrupted'} fullWidth />
                </ScrollView>
                {truncated && <Text style={styles.meta}>显示部分输出；更多已接收内容请下载日志。</Text>}
                {logPath && sessionId && (
                    <Pressable accessibilityRole="button" accessibilityLabel="下载命令日志" disabled={progress !== null} onPress={download} style={styles.download}>
                        <Text style={styles.downloadText}>{progress === null ? '下载命令日志' : `正在下载 ${Math.round(progress * 100)}%`}</Text>
                    </Pressable>
                )}
            </View>
        </ToolSectionView>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: { gap: 8, minWidth: 0 },
    output: { maxHeight: 320 },
    meta: { color: theme.colors.textSecondary, fontSize: theme.typography.caption.fontSize },
    download: { minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start', paddingHorizontal: 8 },
    downloadText: { color: theme.colors.text, fontSize: theme.typography.small.fontSize, textDecorationLine: 'underline' },
}));
