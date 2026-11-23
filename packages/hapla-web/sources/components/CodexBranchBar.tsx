import * as React from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, View, useWindowDimensions } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import type { Metadata } from '@/sync/storageTypes';
import { sessionGetCodexThreadStatus } from '@/sync/ops';

type Branch = NonNullable<Metadata['codexBranches']>[number];

function compactThreadId(threadId: string): string {
    if (threadId.length <= 20) return threadId;
    return `${threadId.slice(0, 8)}…${threadId.slice(-6)}`;
}

function compactBranchLabel(label: string, length = 8): string {
    const characters = Array.from(label.trim());
    if (characters.length <= length) return label.trim();
    return `${characters.slice(0, length).join('')}…`;
}

export function CodexBranchBar(props: {
    sessionId: string;
    branches: Branch[];
    activeBranchId?: string;
    onSwitch: (branchId: string) => Promise<unknown>;
    onError?: (error: unknown) => void;
}) {
    const { theme } = useUnistyles();
    const { height } = useWindowDimensions();
    const compact = Platform.OS === 'web' && height <= 500 && typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;
    const [switchingBranchId, setSwitchingBranchId] = React.useState<string | null>(null);
    const [verifiedRuntime, setVerifiedRuntime] = React.useState<{ branchId: string; threadId: string } | null>(null);
    const activeVerifiedRuntime = verifiedRuntime?.branchId === props.activeBranchId ? verifiedRuntime : null;
    React.useEffect(() => {
        let cancelled = false;
        setVerifiedRuntime(null);
        const expected = props.branches.find((branch) => branch.id === props.activeBranchId);
        if (!expected) return () => { cancelled = true; };
        void (async () => {
            for (let attempt = 0; attempt < 30 && !cancelled; attempt += 1) {
                try {
                    const status = await sessionGetCodexThreadStatus(props.sessionId);
                    if (status.branchId === expected.id && status.threadId === expected.threadId) {
                        if (!cancelled) setVerifiedRuntime(status);
                        return;
                    }
                } catch {
                    // The runtime may still be synchronizing after transparent
                    // continuation. Absence of a verified badge is never success.
                }
                await new Promise((resolve) => setTimeout(resolve, 250));
            }
        })();
        return () => { cancelled = true; };
    }, [props.activeBranchId, props.branches, props.sessionId]);
    if (props.branches.length < 2) return null;
    return (
        <View style={styles.branchPanel} accessibilityLabel={`对话分支，共 ${props.branches.length} 个`}>
            {!compact && <View style={styles.branchHeading}>
                <Ionicons name="git-branch-outline" size={15} color={theme.colors.textSecondary} />
                <Text style={styles.branchHeadingText}>对话分支</Text>
                <Text style={styles.branchCount}>{props.branches.length}</Text>
            </View>}
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={[styles.branchBar, compact && { paddingTop: 0, paddingBottom: 0 }]}>
                {props.branches.map((branch, index) => {
                    const selected = branch.id === props.activeBranchId;
                    const isSwitchingHere = branch.id === switchingBranchId;
                    const shortLabel = branch.label === 'Original'
                        ? branch.label
                        : `${index + 1} · ${compactBranchLabel(branch.label)}`;
                    return (
                        <Pressable
                            key={branch.id}
                            disabled={selected || switchingBranchId !== null}
                            accessibilityRole="button"
                            accessibilityLabel={`${selected ? '当前分支，' : '切换到分支，'}${branch.label}`}
                            accessibilityState={{ selected, disabled: selected || switchingBranchId !== null, busy: isSwitchingHere }}
                            {...({ 'aria-pressed': selected } as any)}
                            onPress={() => {
                                setSwitchingBranchId(branch.id);
                                setVerifiedRuntime(null);
                                void props.onSwitch(branch.id)
                                    .then((result) => {
                                        if (
                                            result
                                            && typeof result === 'object'
                                            && 'branchId' in result
                                            && 'threadId' in result
                                            && typeof result.branchId === 'string'
                                            && typeof result.threadId === 'string'
                                        ) {
                                            setVerifiedRuntime({ branchId: result.branchId, threadId: result.threadId });
                                        }
                                    })
                                    .catch(props.onError)
                                    .finally(() => setSwitchingBranchId(null));
                            }}
                            style={[styles.branchChip, selected && styles.branchChipActive]}
                        >
                            {isSwitchingHere ? <ActivityIndicator size="small" color={theme.colors.text} /> : null}
                            <Text
                                numberOfLines={1}
                                ellipsizeMode="tail"
                                style={selected ? styles.branchTextActive : styles.branchText}
                            >
                                {isSwitchingHere ? `切换 · ${shortLabel}` : selected ? `当前 · ${shortLabel}` : shortLabel}
                            </Text>
                        </Pressable>
                    );
                })}
            </ScrollView>
            {activeVerifiedRuntime && !compact ? (
                <View style={styles.runtimeVerification} accessibilityLabel={`Codex 运行时已验证，线程 ${activeVerifiedRuntime.threadId}`}>
                    <View style={styles.runtimeDot} />
                    <Text style={styles.runtimeVerificationText} numberOfLines={1} ellipsizeMode="middle">
                        运行时已验证 · {compactThreadId(activeVerifiedRuntime.threadId)}
                    </Text>
                </View>
            ) : null}
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    branchPanel: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.divider },
    branchHeading: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 16, paddingTop: 8 },
    branchHeadingText: { color: theme.colors.textSecondary, fontSize: theme.typography.caption.fontSize, fontWeight: '600' },
    branchCount: { color: theme.colors.textSecondary, fontSize: theme.typography.caption.fontSize, backgroundColor: theme.colors.surfaceHigh, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 8 },
    branchBar: { paddingHorizontal: 16, paddingTop: 6, paddingBottom: 8, gap: 8 },
    branchChip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, minHeight: 44, maxWidth: 220, borderRadius: 22, backgroundColor: theme.colors.surfaceHigh },
    branchChipActive: { backgroundColor: theme.colors.surfacePressed },
    branchText: { minWidth: 0, flexShrink: 1, color: theme.colors.textSecondary, fontSize: theme.typography.caption.fontSize },
    branchTextActive: { minWidth: 0, flexShrink: 1, color: theme.colors.text, fontSize: theme.typography.caption.fontSize, fontWeight: '600' },
    runtimeVerification: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 18, paddingBottom: 8, minWidth: 0 },
    runtimeDot: { width: 7, height: 7, borderRadius: 4, flexShrink: 0, backgroundColor: theme.colors.success },
    runtimeVerificationText: { flex: 1, minWidth: 0, color: theme.colors.textSecondary, fontSize: theme.typography.caption.fontSize },
}));
