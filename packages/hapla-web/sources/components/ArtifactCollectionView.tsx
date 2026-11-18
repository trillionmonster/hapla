import * as React from 'react';
import { Platform, Pressable, View, useWindowDimensions } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useUnistyles } from 'react-native-unistyles';
import { Text } from './StyledText';
import { layout } from './layout';
import { ARTIFACT_PAGE_SIZE, INLINE_ARTIFACT_LIMIT, type ArtifactCollection, type ArtifactItem } from './artifactTimeline';
import { getMediaDisplayName } from './media/mediaDisplayName';
import { ArtifactPresentation } from './ArtifactPresentation';

const labels = { automatic: '过程文件', reference: '相关文件', legacy: '附件' };
const kinds = { video: '视频', image: '图片', audio: '音频', document: '文档' };
const webData = (dataSet: Record<string, string>) => Platform.OS === 'web' ? { dataSet } : {};

export const ArtifactCollectionView = React.memo(function ArtifactCollectionView(props: {
    collection: ArtifactCollection;
    renderItem: (item: ArtifactItem) => React.ReactNode;
    onBeforeChange?: () => void;
}) {
    const { theme } = useUnistyles();
    const width = useWindowDimensions().width;
    const actionHeight = Platform.OS === 'web' && width > 700 ? 32 : 44;
    const { collection } = props;
    const [opened, setOpened] = React.useState(() => collection.origin !== 'automatic' && collection.items.length <= INLINE_ARTIFACT_LIMIT);
    const [page, setPage] = React.useState(0);
    const expanded = opened;
    const pageCount = Math.max(1, Math.ceil(collection.items.length / ARTIFACT_PAGE_SIZE));
    const selectedPage = Math.min(page, pageCount - 1);
    const title = labels[collection.origin];
    const counts = new Map<ArtifactItem['kind'], number>();
    for (const item of collection.items) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
    const summary = [...counts].map(([kind, count]) => `${kinds[kind]} ${count}`).join(' · ');
    const names = collection.items.slice(0, 2).map(item => getMediaDisplayName(item.path, item.name, '文件')).join('、');
    const buttonStyle = { minHeight: 40, paddingHorizontal: 12, alignItems: 'center' as const, justifyContent: 'center' as const, borderRadius: 8, backgroundColor: theme.colors.surface };
    // Web history rows are block elements, so alignSelf alone cannot center
    // this collection as it does inside a native flex column.
    return <View style={{ width: '100%', maxWidth: layout.maxWidth, alignSelf: 'center',
        ...(Platform.OS === 'web' ? { marginHorizontal: 'auto' as const } : {}), paddingHorizontal: 16, marginBottom: 8 }}
        {...webData({ artifactCollection: collection.key, artifactOrigin: collection.origin, haplaHistoryAnchor: collection.key })}>
        <View style={{ borderWidth: 1, borderColor: theme.colors.divider, borderRadius: 9, overflow: 'hidden', backgroundColor: theme.colors.surfaceHigh }}>
            <Pressable accessibilityRole="button" accessibilityLabel={`${expanded ? '收起' : '展开'}${title}`} accessibilityState={{ expanded }}
                onPress={() => { props.onBeforeChange?.(); setOpened(!expanded); if (expanded) setPage(0); }}
                style={{ minHeight: expanded ? actionHeight : 46, paddingHorizontal: 11, paddingVertical: expanded ? 3 : 6, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Ionicons name="layers-outline" size={17} color={theme.colors.textSecondary} />
                <View style={{ flex: 1, minWidth: 0, flexDirection: expanded ? 'row' : 'column', alignItems: expanded ? 'center' : undefined, gap: expanded ? 8 : 0 }}>
                    <Text style={{ color: theme.colors.text, fontSize: theme.typography.small.fontSize, lineHeight: theme.typography.small.lineHeight, fontWeight: '600' }}>{title} · {collection.items.length}</Text>
                    <Text numberOfLines={1} style={{ color: theme.colors.textSecondary, fontSize: theme.typography.caption.fontSize, lineHeight: theme.typography.caption.lineHeight, flexShrink: 1 }}>{summary}{!expanded && names ? ` · ${names}${collection.items.length > 2 ? '…' : ''}` : ''}</Text>
                </View>
                <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={15} color={theme.colors.textSecondary} />
            </Pressable>
            {expanded ? <View {...webData({ artifactExpanded: 'true' })} style={{ borderTopWidth: 1, borderTopColor: theme.colors.divider }}>
                <ArtifactPresentation.Provider value={true}>
                {collection.items.slice(selectedPage * ARTIFACT_PAGE_SIZE, (selectedPage + 1) * ARTIFACT_PAGE_SIZE).map((item, index) =>
                    <View key={item.key} {...webData({ artifactItem: item.key })} style={{ minWidth: 0, paddingHorizontal: 10, paddingVertical: 3,
                        borderTopWidth: index > 0 ? 1 : 0, borderTopColor: theme.colors.divider }}>{props.renderItem(item)}</View>)}
                </ArtifactPresentation.Provider>
                {pageCount > 1 ? <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingBottom: 10, gap: 8 }}>
                    <Pressable accessibilityRole="button" accessibilityLabel="上一页附件" disabled={selectedPage === 0}
                        onPress={() => { props.onBeforeChange?.(); setPage(selectedPage - 1); }} style={{ ...buttonStyle, opacity: selectedPage === 0 ? 0.4 : 1 }}>
                        <Text style={{ color: theme.colors.text, fontSize: theme.typography.caption.fontSize }}>上一页</Text>
                    </Pressable>
                    <Text style={{ color: theme.colors.textSecondary, fontSize: theme.typography.caption.fontSize }}>{selectedPage + 1} / {pageCount}</Text>
                    <Pressable accessibilityRole="button" accessibilityLabel="下一页附件" disabled={selectedPage + 1 === pageCount}
                        onPress={() => { props.onBeforeChange?.(); setPage(selectedPage + 1); }} style={{ ...buttonStyle, opacity: selectedPage + 1 === pageCount ? 0.4 : 1 }}>
                        <Text style={{ color: theme.colors.text, fontSize: theme.typography.caption.fontSize }}>下一页</Text>
                    </Pressable>
                </View> : null}
            </View> : null}
        </View>
    </View>;
});
