import React from 'react';
import { ActivityIndicator, Keyboard, Pressable, ScrollView, Text, TextInput, View, useWindowDimensions } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { StyleSheet,  useUnistyles } from 'react-native-unistyles';
import type { MachineDirectoryResponse } from '@hapla/wire';
import { browseMachineDirectory } from '@/utils/machineDirectoryBrowser';

type Listing = Extract<MachineDirectoryResponse, { success: true }>;
type Props = {
    machineId: string;
    value: string | null;
    recent: { key: string; label: string }[];
    onSelect: (path: string) => void;
    onClose: () => void;
};

/** Draft paths stay local until the machine confirms a directory (or a new path).
 * Opening a row browses it; its check button selects it and closes the picker. */
export function WorkspaceDirectoryPicker({ machineId, value, recent, onSelect, onClose }: Props) {
    const { theme } = useUnistyles();
    const { height } = useWindowDimensions();
    const colors = theme.colors;
    const accent = theme.dark ? '#70b5ff' : '#166acb';
    const [draft, setDraft] = React.useState(value || '~');
    const [listing, setListing] = React.useState<Listing | null>(null);
    const [hidden, setHidden] = React.useState(false);
    const [pending, setPending] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const requestVersion = React.useRef(0);
    const currentPath = React.useRef(value || '~');
    const listRef = React.useRef<ScrollView>(null);
    const activeMachine = React.useRef(machineId);
    activeMachine.current = machineId;

    const navigate = React.useCallback(async (path: string, showHidden: boolean, offset = 0) => {
        const version = ++requestVersion.current;
        setPending(true); setError(null);
        if (!offset) { setListing(null); setDraft(path); currentPath.current = path; }
        const result = await browseMachineDirectory(machineId, { path, showHidden, offset });
        if (version !== requestVersion.current || machineId !== activeMachine.current) return;
        setPending(false);
        if (!result.success) { setError(result.error); return; }
        currentPath.current = result.path;
        setDraft(result.path);
        setListing(previous => offset && previous?.path === result.path
            ? { ...result, entries: [...previous.entries, ...result.entries.filter(item => !previous.entries.some(old => old.path === item.path))] }
            : result);
        if (!offset) listRef.current?.scrollTo({ y: 0, animated: false });
    }, [machineId]);

    React.useEffect(() => {
        void navigate(value || '~', false);
        setHidden(false);
        return () => { requestVersion.current++; };
        // Reopening/machine changes reset navigation; draft edits never change parent selection.
    }, [machineId, navigate]);

    const select = async (path: string) => {
        if (!path.trim()) return;
        const version = ++requestVersion.current;
        setPending(true); setError(null);
        const result = await browseMachineDirectory(machineId, { path, mode: 'check' });
        if (version !== requestVersion.current || machineId !== activeMachine.current) return;
        setPending(false);
        if (!result.success) { setError(result.error); return; }
        Keyboard.dismiss();
        onSelect(result.path);
    };
    const close = () => { requestVersion.current++; Keyboard.dismiss(); onClose(); };
    const text = { color: colors.text };
    const muted = { color: colors.textSecondary };
    const iconButton = (label: string, icon: React.ComponentProps<typeof Ionicons>['name'], action: () => void, disabled = false, selected = false) => (
        <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled, selected }} disabled={disabled}
            onPress={action} style={({ pressed }) => [styles.iconButton, { opacity: disabled ? 0.3 : pressed ? 0.65 : 1, backgroundColor: selected ? `${accent}18` : 'transparent' }]}>
            <Ionicons name={icon} size={19} color={selected ? accent : colors.textSecondary} />
        </Pressable>
    );

    return <View style={styles.container} testID="workspace-directory-picker">
        <View style={styles.header}>
            <Text style={[styles.title, text]}>工作目录</Text>
            {iconButton('关闭目录选择', 'close', close)}
        </View>
        <View style={[styles.address, { borderColor: colors.divider, backgroundColor: colors.input.background }]}>
            <Ionicons name="folder-open-outline" size={18} color={accent} />
            <TextInput accessibilityLabel="目录路径" value={draft} onChangeText={next => {
                requestVersion.current++; setPending(false); setError(null); setDraft(next);
            }} placeholder="输入路径，例如 ~/project" placeholderTextColor={colors.textSecondary}
                style={[styles.input, text]} autoCapitalize="none" autoCorrect={false} spellCheck={false}
                returnKeyType="go" onSubmitEditing={() => { Keyboard.dismiss(); void navigate(draft, hidden); }} />
            {iconButton('浏览输入的路径', 'arrow-forward', () => { Keyboard.dismiss(); void navigate(draft, hidden); }, !draft.trim() || pending)}
        </View>
        {recent.length > 0 && <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.recent} keyboardShouldPersistTaps="handled">
            <Text style={[styles.recentLabel, muted]}>最近</Text>
            {recent.slice(0, 8).map(item => <Pressable key={item.key} disabled={pending} accessibilityRole="button" accessibilityLabel={`选择最近目录 ${item.label}`}
                onPress={() => void select(item.key)} style={({ pressed }) => [styles.chip, { borderColor: colors.divider, opacity: pressed ? 0.65 : 1 }]}>
                <Text numberOfLines={1} style={[styles.small, text]}>{item.label}</Text>
            </Pressable>)}
        </ScrollView>}
        <View style={styles.toolbar}>
            {iconButton('上一级目录', 'arrow-up', () => void navigate(listing?.parentPath || '~', hidden), !listing?.parentPath || pending)}
            {iconButton('主目录', 'home-outline', () => void navigate('~', hidden), pending)}
            <Text style={[styles.caption, muted]}>{listing?.kind === 'directory' ? `${listing.total} 项` : '远端目录'}</Text>
            {pending && <ActivityIndicator size="small" color={accent} accessibilityLabel="正在读取目录" />}
            {iconButton(hidden ? '隐藏隐藏项' : '显示隐藏项', hidden ? 'eye-outline' : 'eye-off-outline', () => {
                setHidden(!hidden); void navigate(currentPath.current, !hidden);
            }, pending, hidden)}
            {iconButton('刷新目录', 'refresh-outline', () => void navigate(currentPath.current, hidden), pending)}
        </View>
        {error && <View style={styles.notice} accessibilityRole="alert">
            <Ionicons name="alert-circle-outline" size={18} color={colors.textSecondary} />
            <Text style={[styles.noticeText, text]}>{error}</Text>
        </View>}
        <ScrollView ref={listRef} style={[styles.list, { height: Math.max(100, Math.min(260, height * 0.7 - 320)), borderColor: colors.divider }]}
            keyboardShouldPersistTaps="handled" nestedScrollEnabled>
            {listing?.kind === 'missing' && <Text style={[styles.empty, muted]}>目录尚不存在。选用后，创建会话时会确认是否新建。</Text>}
            {listing?.kind === 'directory' && listing.entries.length === 0 && !pending && <Text style={[styles.empty, muted]}>此文件夹为空{hidden ? '' : '，或仅含隐藏项'}</Text>}
            {listing?.entries.map(item => <View key={item.path} style={[styles.entry, { opacity: item.type === 'directory' ? 1 : 0.45 }]}>
                <Pressable disabled={item.type !== 'directory' || pending} accessibilityRole="button"
                    accessibilityLabel={`${item.type === 'directory' ? '打开文件夹' : '文件，不可选择'} ${item.name}`}
                    accessibilityState={{ disabled: item.type !== 'directory' || pending }}
                    onPress={() => void navigate(item.path, hidden)} style={({ pressed }) => [styles.entryMain, { opacity: pressed ? 0.65 : 1 }]}>
                    <Ionicons name={item.type === 'directory' ? 'folder-outline' : 'document-outline'} size={19} color={item.type === 'directory' ? accent : colors.textSecondary} />
                    <Text numberOfLines={1} style={[styles.entryName, text]}>{item.name}</Text>
                    {item.symlink && <Ionicons name="link-outline" size={13} color={colors.textSecondary} />}
                    {item.type === 'directory' && <Ionicons name="chevron-forward" size={14} color={colors.textSecondary} />}
                </Pressable>
                {item.type === 'directory' ? iconButton(`选用目录 ${item.name}`, 'checkmark', () => void select(item.path), pending) : <Text style={[styles.fileLabel, muted]}>文件</Text>}
            </View>)}
            {listing?.nextOffset != null && <Pressable accessibilityRole="button" disabled={pending} onPress={() => void navigate(listing.path, hidden, listing.nextOffset!)} style={styles.loadMore}>
                <Text style={{ color: accent }}>加载更多 · 已显示 {listing.entries.length} / {listing.total}</Text>
            </Pressable>}
        </ScrollView>
        <View style={styles.footer}>
            <Text style={[styles.hint, muted]}>点击文件夹浏览，点 ✓ 直接选用</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="使用此路径" disabled={pending || !draft.trim()}
                onPress={() => void select(draft)} style={({ pressed }) => [styles.choose, { backgroundColor: accent, opacity: pending || !draft.trim() ? 0.4 : pressed ? 0.8 : 1 }]}>
                <Text style={[styles.chooseText, { color: theme.dark ? '#071a2f' : '#ffffff' }]}>使用此路径</Text>
            </Pressable>
        </View>
    </View>;
}

const styles = StyleSheet.create((theme) => ({
    container: { paddingHorizontal: 16, paddingBottom: 14 },
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 48 },
    title: { fontSize: theme.typography.body.fontSize, fontWeight: '600' },
    iconButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 9 },
    address: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 12, borderWidth: 1, borderRadius: 10 },
    input: { flex: 1, minWidth: 0, height: 44, paddingVertical: 0, fontSize: theme.typography.body.fontSize },
    recent: { flexGrow: 0, marginTop: 10, maxHeight: 32 },
    recentLabel: { fontSize: theme.typography.caption.fontSize, lineHeight: theme.typography.caption.lineHeight, marginRight: 8 },
    chip: { borderWidth: 1, borderRadius: 7, paddingHorizontal: 9, justifyContent: 'center', height: 30, maxWidth: 220, marginRight: 6 },
    small: { fontSize: theme.typography.caption.fontSize },
    toolbar: { flexDirection: 'row', alignItems: 'center', marginHorizontal: -6 },
    caption: { flex: 1, fontSize: theme.typography.caption.fontSize, paddingLeft: 4 },
    list: { flexGrow: 0, borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth },
    entry: { flexDirection: 'row', alignItems: 'center', minHeight: 44 },
    entryMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44, paddingLeft: 4 },
    entryName: { flex: 1, fontSize: theme.typography.label.fontSize },
    fileLabel: { width: 44, textAlign: 'center', fontSize: theme.typography.caption.fontSize },
    footer: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingTop: 12 },
    hint: { flex: 1, fontSize: theme.typography.caption.fontSize, lineHeight: theme.typography.caption.lineHeight },
    choose: { minHeight: 42, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center', borderRadius: 9 },
    chooseText: { color: '#071a2f', fontWeight: '600', fontSize: theme.typography.small.fontSize },
    empty: { paddingVertical: 24, paddingHorizontal: 8, fontSize: theme.typography.small.fontSize, lineHeight: theme.typography.small.lineHeight },
    notice: { flexDirection: 'row', gap: 8, alignItems: 'center', paddingBottom: 10 },
    noticeText: { flex: 1, fontSize: theme.typography.small.fontSize, lineHeight: theme.typography.small.lineHeight },
    loadMore: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
}));
