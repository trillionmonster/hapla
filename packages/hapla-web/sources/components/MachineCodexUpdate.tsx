import * as React from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { CodexUpdateStatus } from '@hapla/wire';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { ItemGroup } from './ItemGroup';
import { Typography } from '@/constants/Typography';
import type { MachineMetadata } from '@/sync/storageTypes';
import { machineCodexUpdateStart, machineCodexUpdateStatus, machineRefreshCliCapabilities } from '@/sync/ops';
import { sync } from '@/sync/sync';

type Action = 'status' | 'start' | 'refresh';

const stateNames: Record<CodexUpdateStatus['state'], string> = {
    idle: '就绪', checking: '检查版本', installing: '安装中', verifying: '验证安装',
    refreshing: '同步模型', completed: '已完成', failed: '更新失败',
};

function isUpdating(status: CodexUpdateStatus | null): boolean {
    return !!status && ['checking', 'installing', 'verifying', 'refreshing'].includes(status.state);
}

function explainError(error: unknown): string {
    const detail = error instanceof Error ? error.message : String(error);
    if (/RPC method not available|RPC_METHOD_NOT_FOUND|not registered|method not found/i.test(detail)) {
        return '此机器的 Hapla CLI 尚不支持页面更新，请先升级 Hapla CLI。';
    }
    if (/socket|not connected|offline|timed?\s*out|timeout/i.test(detail)) {
        return '连接中断或请求超时；已提交的更新可能仍在运行，请重新读取状态。';
    }
    return detail || '请求失败，请重试。';
}

/** A single, non-overlapping poller. Unmounting never cancels the daemon's job. */
function useCodexUpdate(machineId: string, online: boolean) {
    const [status, setStatus] = React.useState<CodexUpdateStatus | null>(null);
    const [pending, setPending] = React.useState<Action | null>(null);
    const [statusError, setStatusError] = React.useState<string | null>(null);
    const [refreshError, setRefreshError] = React.useState<string | null>(null);
    const [notice, setNotice] = React.useState<string | null>(null);
    const controller = React.useRef<((action: Action) => void) | null>(null);

    React.useEffect(() => {
        let active = true;
        let inFlight = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let refreshedOperation: string | undefined;
        let lastStatus: CodexUpdateStatus | null = null;
        setStatus(null);
        setPending(null);
        setStatusError(null);
        setRefreshError(null);
        setNotice(null);

        async function execute(action: Action) {
            if (!active || !online || inFlight) return;
            inFlight = true;
            clearTimeout(timer);
            setPending(action);
            if (action === 'refresh') setRefreshError(null);
            else setStatusError(null);
            if (action !== 'status') setNotice(null);
            let succeeded = false;
            try {
                if (action === 'refresh') {
                    const capabilities = await machineRefreshCliCapabilities(machineId);
                    if (!active) return;
                    if (!capabilities?.codex) throw new Error('尚未获取到 Codex 能力信息，请确认 CLI 可用后重试。');
                    if (lastStatus) {
                        lastStatus = { ...lastStatus, currentVersion: capabilities.codex.version };
                        setStatus(lastStatus);
                    }
                    setNotice(capabilities.codex.models.length > 0
                        ? '模型列表与档位说明已同步。'
                        : '刷新完成，CLI 暂未返回可用模型。');
                } else {
                    const result = await (action === 'start'
                        ? machineCodexUpdateStart(machineId)
                        : machineCodexUpdateStatus(machineId));
                    if (!active) return;
                    if (!result.success) throw new Error(result.error);
                    lastStatus = result.status;
                    setStatus(result.status);
                    if (result.status.state === 'completed') {
                        const operation = result.status.operationId ?? String(result.status.finishedAt ?? 'completed');
                        if (operation !== refreshedOperation) {
                            // The daemon refreshed its catalog before reporting completion.
                            await sync.refreshMachines();
                            if (!active) return;
                            refreshedOperation = operation;
                        }
                    }
                }
                succeeded = true;
            } catch (reason) {
                if (active) (action === 'refresh' ? setRefreshError : setStatusError)(explainError(reason));
            } finally {
                if (active) {
                    inFlight = false;
                    setPending(null);
                    if (succeeded && isUpdating(lastStatus)) {
                        timer = setTimeout(() => { void execute('status'); }, 2_000);
                    }
                }
            }
        }

        controller.current = (action) => { void execute(action); };
        if (online) void execute('status');
        return () => {
            active = false;
            clearTimeout(timer);
            controller.current = null;
        };
    }, [machineId, online]);

    const error = statusError ? { message: statusError, action: 'status' as const }
        : refreshError ? { message: refreshError, action: 'refresh' as const } : null;
    return { status, pending, error, notice, run: (action: Action) => controller.current?.(action) };
}

export function MachineCodexUpdate({ machineId, online, metadata }: {
    machineId: string;
    online: boolean;
    metadata: MachineMetadata | null;
}) {
    const { theme } = useUnistyles();
    const { status, pending, error, notice, run } = useCodexUpdate(machineId, online);
    const [showModels, setShowModels] = React.useState(false);
    const catalog = metadata?.cliCapabilities?.codex;
    const models = catalog?.models ?? metadata?.codexModels ?? [];
    const version = status?.currentVersion ?? catalog?.version ?? metadata?.codexVersion;
    const displayVersion = version?.trim().replace(/^codex(?:-cli)?\s+/i, '').replace(/^v(?=\d)/, '');
    const busy = isUpdating(status);
    const updateDisabled = !online || !!pending || busy || !status || status.updateSupported === false || error?.action === 'status';
    const refreshDisabled = !online || !!pending || busy;
    const label = !online ? '机器离线' : error?.action === 'status' ? '状态待确认' : status ? stateNames[status.state] : pending ? '读取状态' : '状态未读取';
    const failed = status?.state === 'failed';
    const statusColor = error || failed ? theme.colors.textDestructive : busy ? theme.colors.textLink : theme.colors.textSecondary;

    return (
        <ItemGroup title="Codex CLI">
            <View testID="machine-codex-update" style={styles.container}>
                <View style={styles.header}>
                    <View style={styles.heading}>
                        <Text testID="codex-update-version" style={styles.version}>{displayVersion ? `v${displayVersion}` : '版本待检测'}</Text>
                        <Text testID="codex-update-state" style={[styles.caption, { color: statusColor }]} accessibilityLiveRegion="polite">{label}</Text>
                    </View>
                    {(busy && !error && online) || pending ? <ActivityIndicator size="small" color={theme.colors.textLink} /> : null}
                </View>
                <Text style={styles.caption}>
                    {!online ? '机器重新连接后可更新 CLI 或同步模型。' : status?.message || (pending ? '正在读取此机器的安装信息…' : '读取安装状态后可更新 CLI。')}
                </Text>
                {status?.updateSupported === false && status.unsupportedReason && (
                    <Text style={styles.caption}>{status.unsupportedReason}</Text>
                )}
                {failed && status.error && <Text style={styles.error}>{status.error}</Text>}
                {(error || (!status && !pending && online)) && (
                    <View style={styles.errorRow}>
                        <Text style={[styles.error, styles.grow]} accessibilityLiveRegion="polite">{error?.message || '请重新读取安装状态。'}</Text>
                        <Pressable accessibilityRole="button" accessibilityLabel={error?.action === 'refresh' ? '重试同步模型与档位' : '重新读取 Codex 更新状态'} disabled={!online || !!pending}
                            onPress={() => run(error?.action ?? 'status')} style={styles.retry}>
                            <Text style={styles.link}>重试</Text>
                        </Pressable>
                    </View>
                )}
                {notice && <Text style={styles.caption} accessibilityLiveRegion="polite">{notice}</Text>}
                <View style={styles.actions}>
                    <Pressable accessibilityRole="button" accessibilityLabel="更新 Codex CLI" accessibilityState={{ disabled: updateDisabled }}
                        disabled={updateDisabled} onPress={() => run('start')} style={[styles.button, updateDisabled && styles.disabled]}>
                        <Ionicons name="download-outline" size={16} color={theme.colors.textLink} />
                        <Text style={styles.link}>{busy ? '更新进行中' : failed ? '重试更新' : '更新 CLI'}</Text>
                    </Pressable>
                    <Pressable accessibilityRole="button" accessibilityLabel="刷新模型与档位" accessibilityState={{ disabled: refreshDisabled }}
                        disabled={refreshDisabled} onPress={() => run('refresh')} style={[styles.button, refreshDisabled && styles.disabled]}>
                        <Ionicons name="refresh-outline" size={16} color={theme.colors.textSecondary} />
                        <Text style={styles.buttonText}>{pending === 'refresh' ? '同步中…' : '刷新模型与档位'}</Text>
                    </Pressable>
                </View>
                <Text style={styles.footnote}>新版用于新启动的 Codex；运行中的任务保持原版本。更新后自动同步模型与档位说明，离开页面后更新继续。</Text>
                <Pressable accessibilityRole="button" accessibilityLabel="模型与档位说明" accessibilityState={{ expanded: showModels }}
                    onPress={() => setShowModels((value) => !value)} style={styles.catalogToggle}>
                    <Text style={styles.buttonText}>模型与档位说明 · {models.length}</Text>
                    <Ionicons name={showModels ? 'chevron-up' : 'chevron-down'} size={15} color={theme.colors.textSecondary} />
                </Pressable>
                {showModels && (
                    <View style={styles.models}>
                        {models.length === 0 && <Text style={styles.caption}>尚无此机器上报的模型列表，请连接后刷新。</Text>}
                        {models.map((model) => (
                            <View key={model.code} style={styles.model}>
                                <Text style={styles.modelName}>{model.value}</Text>
                                {model.code !== model.value && <Text style={styles.footnote}>{model.code}</Text>}
                                {!!model.description && <Text style={styles.caption}>{model.description}</Text>}
                                {model.supportedEffortLevels?.map((level) => (
                                    <View key={level} style={styles.effort}>
                                        <Text style={styles.effortName}>{level}{model.defaultEffortLevel === level ? ' · 默认' : ''}</Text>
                                        <Text style={[styles.caption, styles.grow]}>{model.effortDescriptions?.[level] || 'CLI 未提供此档位的说明'}</Text>
                                    </View>
                                ))}
                            </View>
                        ))}
                    </View>
                )}
            </View>
        </ItemGroup>
    );
}

const styles = StyleSheet.create((theme) => ({
    container: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 4, gap: 7 },
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
    heading: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 10, flex: 1 },
    version: { ...Typography.default('semiBold'), fontSize: theme.typography.body.fontSize, color: theme.colors.text },
    caption: { ...Typography.default(), fontSize: theme.typography.small.fontSize, lineHeight: theme.typography.small.lineHeight, color: theme.colors.textSecondary },
    footnote: { ...Typography.default(), fontSize: theme.typography.caption.fontSize, lineHeight: theme.typography.caption.lineHeight, color: theme.colors.textSecondary },
    error: { ...Typography.default(), fontSize: theme.typography.small.fontSize, lineHeight: theme.typography.small.lineHeight, color: theme.colors.textDestructive },
    errorRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    grow: { flex: 1, minWidth: 0 },
    retry: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 8 },
    actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingTop: 3 },
    button: { flexDirection: 'row', gap: 6, alignItems: 'center', justifyContent: 'center', minHeight: 40,
        paddingHorizontal: 12, borderRadius: 8, borderWidth: 1, borderColor: theme.colors.divider },
    disabled: { opacity: 0.45 },
    link: { ...Typography.default('semiBold'), fontSize: theme.typography.small.fontSize, color: theme.colors.textLink },
    buttonText: { ...Typography.default(), fontSize: theme.typography.small.fontSize, color: theme.colors.text },
    catalogToggle: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 44,
        borderTopWidth: 1, borderTopColor: theme.colors.divider, marginTop: 4 },
    models: { gap: 12, paddingBottom: 12 },
    model: { gap: 4 },
    modelName: { ...Typography.default('semiBold'), fontSize: theme.typography.label.fontSize, color: theme.colors.text },
    effort: { flexDirection: 'row', gap: 10, paddingTop: 2 },
    effortName: { ...Typography.default(), width: 100, fontSize: theme.typography.caption.fontSize, lineHeight: theme.typography.caption.lineHeight, color: theme.colors.text },
}));
