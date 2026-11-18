import * as React from 'react';
import { Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { ToolViewProps } from './_all';

/** Native fallback. Mobile browsers resolve McpAppSurface.web.tsx instead. */
export const McpAppSurface = React.memo<ToolViewProps & { workspace?: boolean; onClose?: () => void }>(() => {
    const { theme } = useUnistyles();
    return (
        <View style={styles.container}>
            <Text style={[styles.title, { color: theme.colors.text }]}>交互页面可在 Web 端使用</Text>
            <Text style={[styles.body, { color: theme.colors.textSecondary }]}>当前阶段不加载 iOS 原生嵌入容器。</Text>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: { paddingVertical: 18, gap: 6 },
    title: { fontSize: theme.typography.body.fontSize, fontWeight: '600' },
    body: { fontSize: theme.typography.small.fontSize, lineHeight: theme.typography.small.lineHeight },
}));
