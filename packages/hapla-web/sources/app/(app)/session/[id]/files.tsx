import { encodeFileRoutePath } from '@/utils/isolatedFilePreview';
import * as React from 'react';
import {
    ActivityIndicator,
    FlatList,
    Platform,
    Pressable,
    TextInput,
    View,
    useWindowDimensions,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import Octicons from '@expo/vector-icons/Octicons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { FileIcon } from '@/components/FileIcon';
import { Typography } from '@/constants/Typography';
import { layout } from '@/components/layout';
import { Modal } from '@/modal';
import { machineListDirectory, sessionListDirectory } from '@/sync/ops';
import { useSession } from '@/sync/storage';
import {
    FileTransferConflictError,
    downloadWorkspaceFile,
    formatFileSize,
    uploadWorkspaceFile,
} from '@/utils/workspaceFileTransfer';

type DirectoryEntry = {
    name: string;
    type: 'file' | 'directory' | 'other';
    size?: number;
    modified?: number;
};

type TransferItem = {
    id: string;
    name: string;
    progress: number;
    state: 'uploading' | 'completed' | 'error';
    error?: string;
};

function joinWorkspacePath(parent: string, name: string): string {
    return parent ? `${parent.replace(/\/$/, '')}/${name}` : name;
}

function parentWorkspacePath(path: string): string {
    const segments = path.split('/').filter(Boolean);
    segments.pop();
    return segments.join('/');
}

function absoluteWorkspacePath(root: string, relativePath: string): string {
    return relativePath ? `${root.replace(/\/$/, '')}/${relativePath}` : root;
}

function safeBrowserFileName(name: string): string | null {
    const normalized = name.replace(/\\/g, '/').split('/').pop()?.trim() ?? '';
    if (!normalized || normalized === '.' || normalized === '..' || normalized.includes('\0')) return null;
    return normalized;
}

export default React.memo(function FilesScreen() {
    const { id: sessionId } = useLocalSearchParams<{ id: string }>();
    const router = useRouter();
    const { theme } = useUnistyles();
    const { width } = useWindowDimensions();
    const session = useSession(sessionId!);
    const machineId = session?.metadata?.machineId;
    const workspaceRoot = session?.metadata?.path ?? '';
    const workspaceName = session?.metadata?.path?.split('/').filter(Boolean).pop() || 'Workspace';

    const [currentPath, setCurrentPath] = React.useState('');
    const [entries, setEntries] = React.useState<DirectoryEntry[]>([]);
    const [query, setQuery] = React.useState('');
    const [loading, setLoading] = React.useState(true);
    const [error, setError] = React.useState<string | null>(null);
    const [refreshVersion, setRefreshVersion] = React.useState(0);
    const [transfers, setTransfers] = React.useState<TransferItem[]>([]);
    const [downloadProgress, setDownloadProgress] = React.useState<Record<string, number>>({});
    const webFileInputRef = React.useRef<HTMLInputElement | null>(null);

    const refresh = React.useCallback(() => setRefreshVersion((value) => value + 1), []);

    React.useEffect(() => {
        let cancelled = false;
        setLoading(true);
        setError(null);
        if (!sessionId || !workspaceRoot) {
            setError('工作区会话不可用');
            setLoading(false);
            return () => { cancelled = true; };
        }
        const absolutePath = absoluteWorkspacePath(workspaceRoot, currentPath);
        void sessionListDirectory(sessionId, absolutePath).then(async (result) => {
            if (!result.success && result.error === 'RPC method not available' && machineId) {
                return machineListDirectory(machineId, absolutePath);
            }
            return result;
        }).then((result) => {
            if (cancelled) return;
            if (!result.success) {
                setEntries([]);
                setError(result.error || '无法读取此目录');
                return;
            }
            setEntries((result.entries ?? []).filter((entry) => entry.type !== 'other'));
        }).catch((loadError) => {
            if (!cancelled) setError(loadError instanceof Error ? loadError.message : '无法读取此目录');
        }).finally(() => {
            if (!cancelled) setLoading(false);
        });
        return () => { cancelled = true; };
    }, [currentPath, machineId, refreshVersion, sessionId, workspaceRoot]);

    const patchTransfer = React.useCallback((id: string, patch: Partial<TransferItem>) => {
        setTransfers((items) => items.map((item) => item.id === id ? { ...item, ...patch } : item));
    }, []);

    const uploadFiles = React.useCallback(async (files: File[]) => {
        for (const file of files) {
            const name = safeBrowserFileName(file.name);
            if (!name) {
                Modal.alert('上传失败', `无效文件名：${file.name}`);
                continue;
            }
            const destinationPath = joinWorkspacePath(currentPath, name);
            const transferId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
            setTransfers((items) => [...items, { id: transferId, name, progress: 0, state: 'uploading' }]);

            const runUpload = async (overwrite: boolean) => {
                if (!sessionId || !workspaceRoot) throw new Error('工作区会话不可用');
                const transfer = {
                    destinationPath: absoluteWorkspacePath(workspaceRoot, destinationPath),
                    file,
                    overwrite,
                    onProgress: (progress: number) => patchTransfer(transferId, { progress }),
                };
                try {
                    return await uploadWorkspaceFile({ sessionId, ...transfer });
                } catch (error) {
                    if (!machineId || !(error instanceof Error) || error.message !== 'RPC method not available') throw error;
                    return uploadWorkspaceFile({ machineId, ...transfer });
                }
            };

            try {
                try {
                    await runUpload(false);
                } catch (uploadError) {
                    if (!(uploadError instanceof FileTransferConflictError)) throw uploadError;
                    const replace = await Modal.confirm(
                        '替换已有文件？',
                        `${name} 已存在于当前目录。替换后无法从 Hapla 撤销。`,
                        { cancelText: '取消', confirmText: '替换', destructive: true },
                    );
                    if (!replace) {
                        setTransfers((items) => items.filter((item) => item.id !== transferId));
                        continue;
                    }
                    patchTransfer(transferId, { progress: 0 });
                    await runUpload(true);
                }
                patchTransfer(transferId, { progress: 1, state: 'completed' });
                refresh();
                window.setTimeout(() => {
                    setTransfers((items) => items.filter((item) => item.id !== transferId));
                }, 1800);
            } catch (uploadError) {
                patchTransfer(transferId, {
                    state: 'error',
                    error: uploadError instanceof Error ? uploadError.message : '上传失败',
                });
            }
        }
    }, [currentPath, machineId, patchTransfer, refresh, sessionId, workspaceRoot]);

    React.useEffect(() => {
        if (Platform.OS !== 'web' || typeof document === 'undefined') return;
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.tabIndex = -1;
        input.style.position = 'fixed';
        input.style.left = '-9999px';
        input.style.width = '1px';
        input.style.height = '1px';
        input.style.opacity = '0';
        document.body.appendChild(input);
        webFileInputRef.current = input;
        return () => {
            input.remove();
            webFileInputRef.current = null;
        };
    }, []);

    const chooseFiles = React.useCallback(() => {
        if (Platform.OS !== 'web') {
            Modal.alert('暂不支持', '当前项目先支持 Web 和手机浏览器上传。');
            return;
        }
        const input = webFileInputRef.current;
        if (!input) return;
        input.onchange = () => {
            const selected = input.files ? Array.from(input.files) : [];
            input.value = '';
            if (selected.length > 0) void uploadFiles(selected);
        };
        input.click();
    }, [uploadFiles]);

    const openEntry = React.useCallback((entry: DirectoryEntry) => {
        const path = joinWorkspacePath(currentPath, entry.name);
        if (entry.type === 'directory') {
            setQuery('');
            setCurrentPath(path);
            return;
        }
        router.push(`/session/${sessionId}/file?path=${encodeURIComponent(encodeFileRoutePath(path))}`);
    }, [currentPath, router, sessionId]);

    const downloadEntry = React.useCallback(async (entry: DirectoryEntry) => {
        const path = joinWorkspacePath(currentPath, entry.name);
        setDownloadProgress((state) => ({ ...state, [path]: 0 }));
        try {
            if (!sessionId || !workspaceRoot) throw new Error('工作区会话不可用');
            const transfer = {
                path: absoluteWorkspacePath(workspaceRoot, path),
                onProgress: (progress: number) => setDownloadProgress((state) => ({ ...state, [path]: progress })),
            };
            try {
                await downloadWorkspaceFile({ sessionId, ...transfer });
            } catch (error) {
                if (!machineId || !(error instanceof Error) || error.message !== 'RPC method not available') throw error;
                await downloadWorkspaceFile({ machineId, ...transfer });
            }
        } catch (downloadError) {
            if (!(downloadError instanceof Error && downloadError.name === 'AbortError')) Modal.alert('下载失败', downloadError instanceof Error ? downloadError.message : '无法下载此文件');
        } finally {
            setDownloadProgress((state) => {
                const next = { ...state };
                delete next[path];
                return next;
            });
        }
    }, [currentPath, machineId, sessionId, workspaceRoot]);

    const visibleEntries = React.useMemo(() => {
        const normalizedQuery = query.trim().toLocaleLowerCase();
        if (!normalizedQuery) return entries;
        return entries.filter((entry) => entry.name.toLocaleLowerCase().includes(normalizedQuery));
    }, [entries, query]);

    const breadcrumbs = React.useMemo(() => {
        const segments = currentPath.split('/').filter(Boolean);
        return [
            { label: workspaceName, path: '' },
            ...segments.map((segment, index) => ({ label: segment, path: segments.slice(0, index + 1).join('/') })),
        ];
    }, [currentPath, workspaceName]);

    return (
        <View style={[styles.container, { backgroundColor: theme.colors.surface }]}>
            <View style={[styles.header, { borderBottomColor: theme.colors.divider }]}>
                <View style={styles.breadcrumbRow}>
                    {currentPath ? (
                        <Pressable
                            accessibilityRole="button"
                            accessibilityLabel="返回上一级目录"
                            onPress={() => { setQuery(''); setCurrentPath(parentWorkspacePath(currentPath)); }}
                            style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
                        >
                            <Ionicons name="arrow-back" size={19} color={theme.colors.text} />
                        </Pressable>
                    ) : null}
                    <View style={styles.breadcrumbs}>
                        {breadcrumbs.map((crumb, index) => (
                            <React.Fragment key={crumb.path || 'root'}>
                                {index > 0 ? <Text style={[styles.breadcrumbDivider, { color: theme.colors.textSecondary }]}>/</Text> : null}
                                <Pressable
                                    accessibilityRole="button"
                                    accessibilityLabel={`打开路径 ${crumb.label}`}
                                    onPress={() => { setQuery(''); setCurrentPath(crumb.path); }}
                                    style={{ minHeight: 44, justifyContent: 'center' }}
                                >
                                    <Text
                                        numberOfLines={1}
                                        style={[
                                            styles.breadcrumbText,
                                            { color: index === breadcrumbs.length - 1 ? theme.colors.text : theme.colors.textSecondary },
                                        ]}
                                    >
                                        {crumb.label}
                                    </Text>
                                </Pressable>
                            </React.Fragment>
                        ))}
                    </View>
                    <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="上传文件"
                        onPress={chooseFiles}
                        style={({ pressed }) => [styles.uploadButton, { backgroundColor: theme.colors.button.primary.background }, pressed && styles.pressed]}
                    >
                        <Ionicons name="cloud-upload-outline" size={18} color={theme.colors.button.primary.tint} />
                        {width > 430 ? <Text style={[styles.uploadButtonText, { color: theme.colors.button.primary.tint }]}>上传</Text> : null}
                    </Pressable>
                </View>

                <View style={[styles.searchBox, { backgroundColor: theme.colors.input.background }]}>
                    <Octicons name="search" size={16} color={theme.colors.textSecondary} />
                    <TextInput
                        value={query}
                        onChangeText={setQuery}
                        placeholder="搜索当前目录"
                        placeholderTextColor={theme.colors.input.placeholder}
                        autoCapitalize="none"
                        autoCorrect={false}
                        style={[styles.searchInput, { color: theme.colors.text }]}
                    />
                    {query ? (
                        <Pressable accessibilityRole="button" accessibilityLabel="清除搜索" onPress={() => setQuery('')} style={styles.clearSearchButton}>
                            <Ionicons name="close-circle" size={17} color={theme.colors.textSecondary} />
                        </Pressable>
                    ) : null}
                </View>
            </View>

            {transfers.length > 0 ? (
                <View style={[styles.transferPanel, { borderBottomColor: theme.colors.divider, backgroundColor: theme.colors.surfaceHigh }]}>
                    {transfers.map((transfer) => (
                        <View key={transfer.id} style={styles.transferRow}>
                            <Ionicons
                                name={transfer.state === 'error' ? 'alert-circle-outline' : transfer.state === 'completed' ? 'checkmark-circle-outline' : 'cloud-upload-outline'}
                                size={17}
                                color={transfer.state === 'error' ? theme.colors.textDestructive : theme.colors.textSecondary}
                            />
                            <View style={styles.transferCopy}>
                                <Text numberOfLines={1} style={[styles.transferName, { color: theme.colors.text }]}>{transfer.name}</Text>
                                <View style={[styles.progressTrack, { backgroundColor: theme.colors.divider }]}>
                                    <View style={[styles.progressFill, { width: `${Math.max(2, transfer.progress * 100)}%`, backgroundColor: transfer.state === 'error' ? theme.colors.textDestructive : theme.colors.text }]} />
                                </View>
                                {transfer.error ? <Text style={[styles.transferError, { color: theme.colors.textDestructive }]}>{transfer.error}</Text> : null}
                            </View>
                            <Text style={[styles.transferPercent, { color: theme.colors.textSecondary }]}>{Math.round(transfer.progress * 100)}%</Text>
                        </View>
                    ))}
                </View>
            ) : null}

            {loading ? (
                <View style={styles.centerState}>
                    <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                    <Text style={[styles.stateText, { color: theme.colors.textSecondary }]}>正在读取目录</Text>
                </View>
            ) : error ? (
                <View style={styles.centerState}>
                    <Octicons name="alert" size={32} color={theme.colors.textDestructive} />
                    <Text style={[styles.stateTitle, { color: theme.colors.text }]}>无法打开目录</Text>
                    <Text style={[styles.stateText, { color: theme.colors.textSecondary }]}>{error}</Text>
                    <Pressable onPress={refresh} style={({ pressed }) => [styles.retryButton, { borderColor: theme.colors.divider }, pressed && styles.pressed]}>
                        <Text style={[styles.retryText, { color: theme.colors.text }]}>重试</Text>
                    </Pressable>
                </View>
            ) : (
                <FlatList
                    data={visibleEntries}
                    keyExtractor={(entry) => `${entry.type}:${entry.name}`}
                    initialNumToRender={18}
                    maxToRenderPerBatch={16}
                    windowSize={7}
                    renderItem={({ item, index }) => {
                        const path = joinWorkspacePath(currentPath, item.name);
                        const progress = downloadProgress[path];
                        const isDownloading = progress !== undefined;
                        return (
                            <Pressable
                                accessibilityRole="button"
                                accessibilityLabel={`${item.type === 'directory' ? '打开文件夹' : '打开文件'} ${item.name}`}
                                onPress={() => openEntry(item)}
                                style={({ pressed }) => [
                                    styles.fileRow,
                                    { borderBottomColor: theme.colors.divider },
                                    pressed && { backgroundColor: theme.colors.surfacePressedOverlay },
                                    index === visibleEntries.length - 1 && { borderBottomWidth: 0 },
                                ]}
                            >
                                <View style={styles.fileIcon}>
                                    {item.type === 'directory'
                                        ? <Octicons name="file-directory" size={26} color={theme.colors.textSecondary} />
                                        : <FileIcon fileName={item.name} size={27} />}
                                </View>
                                <View style={styles.fileCopy}>
                                    <Text numberOfLines={1} style={[styles.fileName, { color: theme.colors.text }]}>{item.name}</Text>
                                    <Text numberOfLines={1} style={[styles.fileMeta, { color: theme.colors.textSecondary }]}>
                                        {item.type === 'directory' ? '文件夹' : formatFileSize(item.size ?? 0)}
                                    </Text>
                                </View>
                                {item.type === 'file' ? (
                                    <Pressable
                                        accessibilityRole="button"
                                        accessibilityLabel={`下载 ${item.name}`}
                                        disabled={isDownloading}
                                        onPress={(event) => { event.stopPropagation(); void downloadEntry(item); }}
                                        style={({ pressed }) => [styles.rowAction, pressed && styles.pressed]}
                                    >
                                        {isDownloading
                                            ? <Text style={[styles.downloadPercent, { color: theme.colors.textSecondary }]}>{Math.round(progress * 100)}%</Text>
                                            : <Ionicons name="download-outline" size={20} color={theme.colors.textSecondary} />}
                                    </Pressable>
                                ) : <Ionicons name="chevron-forward" size={18} color={theme.colors.textSecondary} />}
                            </Pressable>
                        );
                    }}
                    contentContainerStyle={visibleEntries.length === 0 ? styles.emptyList : styles.listContent}
                    ListEmptyComponent={(
                        <View style={styles.centerState}>
                            <Octicons name={query ? 'search' : 'file-directory'} size={36} color={theme.colors.textSecondary} />
                            <Text style={[styles.stateTitle, { color: theme.colors.text }]}>{query ? '没有匹配的文件' : '这个目录是空的'}</Text>
                            <Text style={[styles.stateText, { color: theme.colors.textSecondary }]}>{query ? '换一个关键词试试' : '可以从这里上传任意类型的文件'}</Text>
                        </View>
                    )}
                />
            )}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: { flex: 1, maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%' },
    header: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 12, borderBottomWidth: Platform.OS === 'web' ? 1 : 0.33, gap: 12 },
    breadcrumbRow: { minHeight: 38, flexDirection: 'row', alignItems: 'center', gap: 8 },
    breadcrumbs: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', overflow: 'hidden' },
    breadcrumbDivider: { marginHorizontal: 7, fontSize: theme.typography.label.fontSize },
    breadcrumbText: { ...Typography.default('semiBold'), fontSize: theme.typography.label.fontSize, maxWidth: 150 },
    iconButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 10 },
    uploadButton: { minWidth: 44, minHeight: 44, paddingHorizontal: 13, borderRadius: 11, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 },
    uploadButtonText: { ...Typography.default('semiBold'), fontSize: theme.typography.label.fontSize },
    searchBox: { height: 44, borderRadius: 12, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 9 },
    searchInput: { flex: 1, minWidth: 0, height: 44, fontSize: theme.typography.body.fontSize, ...Typography.default() },
    clearSearchButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 10 },
    transferPanel: { paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: Platform.OS === 'web' ? 1 : 0.33, gap: 10 },
    transferRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
    transferCopy: { flex: 1, minWidth: 0 },
    transferName: { ...Typography.default('semiBold'), fontSize: theme.typography.small.fontSize, marginBottom: 5 },
    transferPercent: { ...Typography.mono(), fontSize: theme.typography.code.fontSize },
    transferError: { ...Typography.default(), fontSize: theme.typography.caption.fontSize, marginTop: 4 },
    progressTrack: { height: 2, borderRadius: 1, overflow: 'hidden' },
    progressFill: { height: 2, borderRadius: 1 },
    listContent: { paddingBottom: 34 },
    emptyList: { flexGrow: 1 },
    fileRow: { minHeight: 64, marginHorizontal: 16, borderBottomWidth: Platform.OS === 'web' ? 1 : 0.33, flexDirection: 'row', alignItems: 'center' },
    fileIcon: { width: 42, alignItems: 'flex-start', justifyContent: 'center' },
    fileCopy: { flex: 1, minWidth: 0, paddingVertical: 10 },
    fileName: { ...Typography.default('semiBold'), fontSize: theme.typography.body.fontSize, lineHeight: theme.typography.body.lineHeight },
    fileMeta: { ...Typography.default(), fontSize: theme.typography.caption.fontSize, lineHeight: theme.typography.caption.lineHeight },
    rowAction: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 10 },
    downloadPercent: { ...Typography.mono(), fontSize: theme.typography.code.fontSize },
    centerState: { flex: 1, minHeight: 220, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 28 },
    stateTitle: { ...Typography.default('semiBold'), fontSize: theme.typography.body.fontSize, marginTop: 14, textAlign: 'center' },
    stateText: { ...Typography.default(), fontSize: theme.typography.small.fontSize, lineHeight: theme.typography.small.lineHeight, marginTop: 6, textAlign: 'center' },
    retryButton: { minHeight: 44, marginTop: 16, borderWidth: 1, borderRadius: 10, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' },
    retryText: { ...Typography.default('semiBold'), fontSize: theme.typography.small.fontSize },
    pressed: { opacity: 0.68, transform: [{ scale: 0.98 }] },
}));
