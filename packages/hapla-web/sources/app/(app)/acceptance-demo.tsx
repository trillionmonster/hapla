import * as React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { HtmlAcceptanceDemo } from '@/components/acceptance/HtmlAcceptanceDemo';
import { Typography } from '@/constants/Typography';
import { CodexBranchBar } from '@/components/CodexBranchBar';
import { MessageView } from '@/components/MessageView';

const markdownFixture = `# Markdown 完整展示样例

普通段落会把源文本中的软换行合并，同时保留  
显式硬换行。支持 **粗体**、*斜体*、~~删除线~~、\`inline code\`、[安全链接](https://example.com) 与数学 $e^{i\\pi}+1=0$。

> 引用块用于展示解释或警告，不执行其中的 HTML。

- 无序列表
- 带 https://example.com/docs 自动链接

1. 有序步骤
2. 第二步

- [x] 已完成验收计划
- [ ] 正在执行浏览器验收

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 表格横向滚动 | 通过 | 单元格 a \\| b 不会被错误拆开 |
| 代码块 | 通过 | 超长行不撑破页面 |

~~~ts
const result = { branch: 'preserved', protocol: 'generated-schema' };
~~~

$$
\\int_0^1 x^2 dx = \\frac{1}{3}
$$`;

export default function AcceptanceDemo() {
    const params = useLocalSearchParams<{ media?: string | string[] }>();
    const requestedMedia = Array.isArray(params.media) ? params.media[0] : params.media;
    const serverMedia = requestedMedia && /^\/files\/(?!\/)[^\s)]+$/.test(requestedMedia)
        ? requestedMedia
        : null;
    const [branchId, setBranchId] = React.useState('original');
    const branches = React.useMemo(() => [
        { id: 'original', threadId: 'thread-original', label: '原始分支', createdAt: 1 },
        { id: 'edited', threadId: 'thread-edited', label: '重编辑分支', parentId: 'original', createdAt: 2 },
    ], []);
    return (
        <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
            <Text style={styles.title}>全功能展示验收</Text>
            <Text style={styles.lead}>这里直接使用生产 Markdown 组件和浏览器 sandbox iframe，用于肉眼与自动化共同验收，不是效果图。</Text>
            {serverMedia ? (
                <View style={styles.section}>
                    <Text style={styles.sectionTitle}>真实服务器生成媒体</Text>
                    <Text style={styles.note}>此处通过生产结构化 agent-media 消息加载站内 /files/ 地址，用于验证自动发现、上传、消息归约和展示的完整路径。</Text>
                    <View style={styles.card}>
                        <MessageView
                            message={{
                                kind: 'agent-media',
                                id: 'acceptance-generated-media',
                                localId: null,
                                createdAt: 1,
                                media: [{ url: serverMedia, mediaType: 'image/png', name: '真实服务器生成图片' }],
                            }}
                            metadata={null}
                            sessionId="acceptance-generated-media"
                            workspaceMode="normal"
                        />
                    </View>
                </View>
            ) : null}
            <View style={styles.section}>
                <Text style={styles.sectionTitle}>Markdown / GFM / 数学 / 代码</Text>
                <View style={styles.card}><MarkdownView markdown={markdownFixture} showCode /></View>
            </View>
            <View style={styles.section}>
                <Text style={styles.sectionTitle}>真实分支选择组件</Text>
                <Text style={styles.note}>生产会话和本样例共用同一个选择器；后端切换由 Codex `thread/resume` 完成。</Text>
                <View style={styles.card}>
                    <CodexBranchBar sessionId="acceptance-demo" branches={branches} activeBranchId={branchId} onSwitch={async (next) => setBranchId(next)} />
                    <Text accessibilityLiveRegion="polite" style={styles.branchResult}>{branchId === 'original' ? '原分支仍保留' : '正在查看重编辑后的新分支'}</Text>
                </View>
            </View>
            <View style={styles.section}>
                <Text style={styles.sectionTitle}>HTML 沙箱界面</Text>
                <Text style={styles.note}>允许 iframe 内脚本和交互，但不授予同源权限；普通 Markdown 中的原始 HTML 不执行。</Text>
                <HtmlAcceptanceDemo />
            </View>
        </ScrollView>
    );
}

const styles = StyleSheet.create((theme) => ({
    screen: { flex: 1, backgroundColor: theme.colors.surface },
    content: { width: '100%', maxWidth: 960, alignSelf: 'center', paddingHorizontal: 16, paddingTop: 24, paddingBottom: 64, gap: 24 },
    title: { color: theme.colors.text, fontSize: theme.typography.title.fontSize, ...Typography.default('semiBold') },
    lead: { color: theme.colors.textSecondary, fontSize: theme.typography.label.fontSize, lineHeight: theme.typography.label.lineHeight, ...Typography.default() },
    section: { width: '100%', gap: 10 },
    sectionTitle: { color: theme.colors.text, fontSize: theme.typography.body.fontSize, ...Typography.default('semiBold') },
    note: { color: theme.colors.textSecondary, fontSize: theme.typography.caption.fontSize, lineHeight: theme.typography.caption.lineHeight, ...Typography.default() },
    card: { width: '100%', padding: 16, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider, borderRadius: 12, backgroundColor: theme.colors.surfaceHigh },
    branchResult: { color: theme.colors.text, paddingHorizontal: 16, paddingVertical: 14, fontSize: theme.typography.label.fontSize },
}));
