import { MarkdownSpan, parseMarkdown } from './parseMarkdown';
import * as React from 'react';
import { Pressable, ScrollView, View, Platform } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { StyleSheet } from 'react-native-unistyles';
import { Text } from '../StyledText';
import { Typography } from '@/constants/Typography';
import { SimpleSyntaxHighlighter } from '../SimpleSyntaxHighlighter';
import { Modal } from '@/modal';
import { useLocalSetting } from '@/sync/storage';
import * as Clipboard from 'expo-clipboard';
import * as WebBrowser from 'expo-web-browser';
import { t } from '@/text';
import { isHttpMarkdownLink, isPotentialWorkspaceMarkdownLink } from './linkUtils';
import { MediaGallery } from '../media/MediaGallery';
import { storage } from '@/sync/storage';
import { resolveSessionFilePath } from '@/utils/sessionFileLinks';
import { useRouter } from 'expo-router';
import { useIsFocused } from '@react-navigation/native';
import { encodeFileRoutePath } from '@/utils/isolatedFilePreview';
import { createWorkspaceStream } from '@/utils/workspaceStream';
import { sessionResources } from '@/sync/sessionResources';
import { inferMediaType } from '../media/mediaKind';
import { resolveMediaSource } from '../media/mediaSource';
import { MathRenderer } from './MathRenderer';

const LazyMermaidRenderer = React.lazy(async () => {
    const module = await import('./MermaidRenderer');
    return { default: module.MermaidRenderer };
});

// Option type for callback
export type Option = {
    title: string;
};

export const MarkdownView = React.memo((props: { 
    markdown: string;
    onOptionPress?: (option: Option) => void;
    sessionId?: string;
    showCode?: boolean;
}) => {
    const router = useRouter();
    const blocks = React.useMemo(() => parseMarkdown(props.markdown), [props.markdown]);
    
    // Backwards compatibility: The original version just returned the view, wrapping the list of blocks.
    // It made each of the individual text elements selectable. When we enable the markdownCopyV2 feature,
    // we disable the selectable property on individual text segments on mobile only. Instead, the long press
    // will be handled by a wrapper Pressable. If we don't disable the selectable property, then you will see
    // the native copy modal come up at the same time as the long press handler is fired.
    const markdownCopyV2 = useLocalSetting('markdownCopyV2');
    const selectable = Platform.OS === 'web' || !markdownCopyV2;

    const handleLinkPress = React.useCallback((url: string) => {
        if (isHttpMarkdownLink(url)) {
            if (Platform.OS === 'web') {
                if (typeof window !== 'undefined') window.open(url, '_blank', 'noopener,noreferrer');
            } else {
                void WebBrowser.openBrowserAsync(url);
            }
            return;
        }
        if (!props.sessionId || !isPotentialWorkspaceMarkdownLink(url)) return;
        const sessionRoot = storage.getState().sessions[props.sessionId]?.metadata?.path;
        const file = resolveSessionFilePath(url, sessionRoot);
        if (!file?.withinSessionRoot) return;
        router.push(`/session/${props.sessionId}/file?path=${encodeURIComponent(encodeFileRoutePath(file.absolutePath))}`);
    }, [props.sessionId, router]);

    const handleLongPress = React.useCallback(() => {
        void Clipboard.setStringAsync(props.markdown).catch((error) => {
            console.error('Error copying markdown:', error);
            Modal.alert('Error', 'Failed to copy this message. Please try again.');
        });
    }, [props.markdown]);
    const renderContent = () => {
        return (
            <View style={{ width: '100%' }} {...(Platform.OS === 'web' ? { dataSet: { haplaMarkdown: 'true' } } : {})}>
                {blocks.map((block, index) => {
                    if (block.type === 'text') {
                        return <RenderTextBlock spans={block.content} key={index} first={index === 0} last={index === blocks.length - 1} selectable={selectable} onLinkPress={handleLinkPress} />;
                    } else if (block.type === 'header') {
                        return <RenderHeaderBlock level={block.level} spans={block.content} key={index} first={index === 0} last={index === blocks.length - 1} selectable={selectable} onLinkPress={handleLinkPress} />;
                    } else if (block.type === 'horizontal-rule') {
                        return <View style={style.horizontalRule} key={index} />;
                    } else if (block.type === 'blockquote') {
                        return <View style={style.blockquote} key={index}><Text selectable={selectable} style={style.text}><RenderSpans spans={block.content} baseStyle={style.text} selectable={selectable} onLinkPress={handleLinkPress} /></Text></View>;
                    } else if (block.type === 'list') {
                        return <RenderListBlock items={block.items} key={index} first={index === 0} last={index === blocks.length - 1} selectable={selectable} onLinkPress={handleLinkPress} />;
                    } else if (block.type === 'numbered-list') {
                        return <RenderNumberedListBlock items={block.items} key={index} first={index === 0} last={index === blocks.length - 1} selectable={selectable} onLinkPress={handleLinkPress} />;
                    } else if (block.type === 'task-list') {
                        return <RenderTaskListBlock items={block.items} key={index} selectable={selectable} onLinkPress={handleLinkPress} />;
                    } else if (block.type === 'code-block') {
                        return props.showCode === false
                            ? null
                            : <RenderCodeBlock content={block.content} language={block.language} key={index} first={index === 0} last={index === blocks.length - 1} selectable={selectable} />;
                    } else if (block.type === 'mermaid') {
                        if (props.showCode === false) {
                            return null;
                        }
                        return (
                            <React.Suspense fallback={<View style={{ width: '100%', height: 100 }} />} key={index}>
                                <LazyMermaidRenderer content={block.content} />
                            </React.Suspense>
                        );
                    } else if (block.type === 'math') {
                        return <MathRenderer content={block.content} displayMode key={index} />;
                    } else if (block.type === 'options') {
                        return <RenderOptionsBlock items={block.items} key={index} first={index === 0} last={index === blocks.length - 1} selectable={selectable} onOptionPress={props.onOptionPress} />;
                    } else if (block.type === 'table') {
                        return <RenderTableBlock headers={block.headers} rows={block.rows} onLinkPress={handleLinkPress} selectable={selectable} key={index} first={index === 0} last={index === blocks.length - 1} />;
                    } else if (block.type === 'image') {
                        return <RenderImageBlock url={block.url} alt={block.alt} sessionId={props.sessionId} key={index} first={index === 0} last={index === blocks.length - 1} />;
                    } else {
                        return null;
                    }
                })}
            </View>
        );
    }

    if (!markdownCopyV2) {
        return renderContent();
    }
    
    if (Platform.OS === 'web') {
        return renderContent();
    }
    
    // Use GestureDetector with LongPress gesture - it doesn't block pan gestures
    // so horizontal scrolling in code blocks and tables still works
    const longPressGesture = Gesture.LongPress()
        .minDuration(500)
        .onStart(() => {
            handleLongPress();
        })
        .runOnJS(true);

    return (
        <GestureDetector gesture={longPressGesture}>
            <View style={{ width: '100%' }}>
                {renderContent()}
            </View>
        </GestureDetector>
    );
});

type RenderSpanProps = {
    spans: MarkdownSpan[];
    baseStyle?: any;
    selectable: boolean;
    onLinkPress: (url: string) => void;
};

function RenderTextBlock(props: { spans: MarkdownSpan[], first: boolean, last: boolean, selectable: boolean, onLinkPress: (url: string) => void }) {
    return <Text selectable={props.selectable} style={[style.text, props.first && style.first, props.last && style.last]}><RenderSpans spans={props.spans} baseStyle={style.text} selectable={props.selectable} onLinkPress={props.onLinkPress} /></Text>;
}

function RenderHeaderBlock(props: { level: 1 | 2 | 3 | 4 | 5 | 6, spans: MarkdownSpan[], first: boolean, last: boolean, selectable: boolean, onLinkPress: (url: string) => void }) {
    const s = (style as any)[`header${props.level}`];
    const headerStyle = [style.header, s, props.first && style.first, props.last && style.last];
    return <Text selectable={props.selectable} style={headerStyle}><RenderSpans spans={props.spans} baseStyle={headerStyle} selectable={props.selectable} onLinkPress={props.onLinkPress} /></Text>;
}

function RenderListBlock(props: { items: MarkdownSpan[][], first: boolean, last: boolean, selectable: boolean, onLinkPress: (url: string) => void }) {
    const listStyle = [style.text, style.list];
    return (
        <View style={{ flexDirection: 'column', marginBottom: 8, gap: 1 }}>
            {props.items.map((item, index) => (
                <Text selectable={props.selectable} style={listStyle} key={index}>- <RenderSpans spans={item} baseStyle={listStyle} selectable={props.selectable} onLinkPress={props.onLinkPress} /></Text>
            ))}
        </View>
    );
}

function RenderNumberedListBlock(props: { items: { number: number, spans: MarkdownSpan[] }[], first: boolean, last: boolean, selectable: boolean, onLinkPress: (url: string) => void }) {
    const listStyle = [style.text, style.list];
    return (
        <View style={{ flexDirection: 'column', marginBottom: 8, gap: 1 }}>
            {props.items.map((item, index) => (
                <Text selectable={props.selectable} style={listStyle} key={index}>{item.number.toString()}. <RenderSpans spans={item.spans} baseStyle={listStyle} selectable={props.selectable} onLinkPress={props.onLinkPress} /></Text>
            ))}
        </View>
    );
}

function RenderTaskListBlock(props: { items: { checked: boolean, spans: MarkdownSpan[] }[], selectable: boolean, onLinkPress: (url: string) => void }) {
    const listStyle = [style.text, style.list];
    return (
        <View accessibilityRole="list" style={{ flexDirection: 'column', marginBottom: 8, gap: 2 }}>
            {props.items.map((item, index) => (
                <View accessibilityRole={'listitem' as any} key={index} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 7 }}>
                    <Text accessibilityLabel={item.checked ? 'completed' : 'not completed'} style={[listStyle, style.taskMarker]}>
                        {item.checked ? '☑' : '☐'}
                    </Text>
                    <Text selectable={props.selectable} style={[listStyle, { flex: 1 }]}>
                        <RenderSpans spans={item.spans} baseStyle={listStyle} selectable={props.selectable} onLinkPress={props.onLinkPress} />
                    </Text>
                </View>
            ))}
        </View>
    );
}

function RenderCodeBlock(props: { content: string, language: string | null, first: boolean, last: boolean, selectable: boolean }) {
    const [isHovered, setIsHovered] = React.useState(false);

    const copyCode = React.useCallback(async () => {
        try {
            await Clipboard.setStringAsync(props.content);
            Modal.alert(t('common.success'), t('markdown.codeCopied'), [{ text: t('common.ok'), style: 'cancel' }]);
        } catch (error) {
            console.error('Failed to copy code:', error);
            Modal.alert(t('common.error'), t('markdown.copyFailed'), [{ text: t('common.ok'), style: 'cancel' }]);
        }
    }, [props.content]);

    return (
        <View
            style={[style.codeBlock, props.first && style.first, props.last && style.last]}
            // @ts-ignore - Web only events
            onMouseEnter={() => setIsHovered(true)}
            // @ts-ignore - Web only events
            onMouseLeave={() => setIsHovered(false)}
        >
            {props.language && <Text selectable={props.selectable} style={style.codeLanguage}>{props.language}</Text>}
            <ScrollView
                style={{ flexGrow: 0, flexShrink: 0 }}
                horizontal={true}
                contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 16 }}
                showsHorizontalScrollIndicator={false}
            >
                <SimpleSyntaxHighlighter
                    code={props.content}
                    language={props.language}
                    selectable={props.selectable}
                />
            </ScrollView>
            <View
                style={[style.copyButtonWrapper, isHovered && style.copyButtonWrapperVisible]}
                {...(Platform.OS === 'web' ? ({ className: 'copy-button-wrapper' } as any) : {})}
            >
                <Pressable
                    style={style.copyButton}
                    onPress={copyCode}
                >
                    <Text style={style.copyButtonText}>{t('common.copy')}</Text>
                </Pressable>
            </View>
        </View>
    );
}

function RenderImageBlock(props: { url: string, alt: string, sessionId?: string, first: boolean, last: boolean }) {
    const router = useRouter();
    const focused = useIsFocused();
    const [resolvedUrl, setResolvedUrl] = React.useState<string | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [attempt, setAttempt] = React.useState(0);
    const { url, direct, localFile, workspaceVideo, mediaType, name } = resolveMediaSource(props.url, {
        sessionId: props.sessionId,
        sessionRoot: props.sessionId ? storage.getState().sessions[props.sessionId]?.metadata?.path : null,
        name: props.alt, declaredType: 'image/unknown',
    });
    React.useEffect(() => {
        setResolvedUrl(null); setError(null);
        if (workspaceVideo) return;
        if (!focused) return;
        if (direct) { setResolvedUrl(url); return; }
        if (!props.sessionId || !localFile?.withinSessionRoot) { setError('只允许预览当前工作区内的本地媒体'); return; }
        // SVG documents use the sanitized, opaque-origin document preview.
        if (inferMediaType(localFile.absolutePath) === 'image/svg+xml') return;
        const abort = new AbortController();
        const unregister = sessionResources.register(props.sessionId, () => { abort.abort(); setResolvedUrl(null); });
        let release: (() => void) | undefined;
        void createWorkspaceStream({ sessionId: props.sessionId, path: localFile.absolutePath, signal: abort.signal })
            .then(stream => { release = stream.release; if (abort.signal.aborted) release(); else setResolvedUrl(stream.url); })
            .catch(problem => { if (!abort.signal.aborted) setError(problem instanceof Error ? problem.message : '媒体读取失败'); });
        return () => { unregister(); abort.abort(); release?.(); };
    }, [props.sessionId, props.url, focused, attempt]);
    // Image blocks carry explicit Markdown intent or a recognized media address.
    // Keep extensionless ![] previews while letting known audio/video types win.
    return (
        <View style={[style.imageBlock, props.first && style.first, props.last && style.last]}>
            {resolvedUrl || workspaceVideo ? <MediaGallery media={[{ url: workspaceVideo ? url : resolvedUrl!, workspaceVideo,
                workspaceFile: localFile?.withinSessionRoot && props.sessionId ? { sessionId: props.sessionId, path: localFile.absolutePath } : undefined, mediaType, name }]} /> : null}
            {error ? <View><Text style={style.imageCaption}>{error}</Text><Pressable accessibilityRole="button" accessibilityLabel="重试媒体读取" onPress={() => setAttempt(value => value + 1)} style={{ minHeight: 44, justifyContent: 'center' }}><Text style={style.imageCaption}>重试</Text></Pressable></View> : null}
            {localFile?.withinSessionRoot && mediaType === 'image/svg+xml' ? <Pressable accessibilityRole="button" accessibilityLabel={`预览 ${name}`} onPress={() => router.push(`/session/${props.sessionId}/file?path=${encodeURIComponent(encodeFileRoutePath(localFile.absolutePath))}`)} style={{ minHeight: 44, justifyContent: 'center' }}><Text style={style.imageCaption}>预览 {name}</Text></Pressable> : null}
        </View>
    );
}

function RenderOptionsBlock(props: { 
    items: string[], 
    first: boolean, 
    last: boolean, 
    selectable: boolean,
    onOptionPress?: (option: Option) => void 
}) {
    return (
        <View style={[style.optionsContainer, props.first && style.first, props.last && style.last]}>
            {props.items.map((item, index) => {
                if (props.onOptionPress) {
                    return (
                        <Pressable 
                            key={index} 
                            style={({ pressed }) => [
                                style.optionItem,
                                pressed && style.optionItemPressed
                            ]}
                            onPress={() => props.onOptionPress?.({ title: item })}
                        >
                            <Text selectable={props.selectable} style={style.optionText}>{item}</Text>
                        </Pressable>
                    );
                } else {
                    return (
                        <View key={index} style={style.optionItem}>
                            <Text selectable={props.selectable} style={style.optionText}>{item}</Text>
                        </View>
                    );
                }
            })}
        </View>
    );
}

function RenderSpans(props: RenderSpanProps) {
    return (<>
        {props.spans.map((span, index) => {
            if (span.styles.includes('math')) {
                return <MathRenderer key={index} content={span.text} />;
            }
            const spanStyles = span.styles.flatMap((styleName) => styleName === 'math' ? [] : [style[styleName]]);
            if (span.url) {
                const isExternalLink = isHttpMarkdownLink(span.url);
                const isWorkspaceLink = isPotentialWorkspaceMarkdownLink(span.url);
                const isInteractiveLink = isExternalLink || isWorkspaceLink;
                return (
                    <Text
                        key={index}
                        selectable={props.selectable}
                        accessibilityRole={isInteractiveLink ? 'link' : undefined}
                        accessibilityHint={isWorkspaceLink ? '下载工作区文件' : undefined}
                        style={[props.baseStyle, isInteractiveLink && style.link, spanStyles]}
                        {...(isInteractiveLink && Platform.OS === 'web' ? { onClick: () => props.onLinkPress(span.url!) } as any : {})}
                        onPress={isInteractiveLink && Platform.OS !== 'web' ? () => props.onLinkPress(span.url!) : undefined}
                    >
                        {span.text}
                    </Text>
                );
            } else {
                return <Text key={index} selectable={props.selectable} style={[props.baseStyle, spanStyles]}>{span.text}</Text>
            }
        })}
    </>)
}

// Table rendering uses column-first layout to ensure consistent column widths.
// Each column is rendered as a vertical container with all its cells (header + data).
// This ensures that cells in the same column have the same width, determined by the widest content.
function RenderTableBlock(props: {
    headers: MarkdownSpan[][],
    rows: MarkdownSpan[][][],
    onLinkPress: (url: string) => void,
    selectable: boolean,
    first: boolean,
    last: boolean
}) {
    const columnCount = props.headers.length;
    const rowCount = props.rows.length;
    const isLastRow = (rowIndex: number) => rowIndex === rowCount - 1;

    return (
        <View style={[style.tableContainer, props.first && style.first, props.last && style.last]}>
            <ScrollView
                horizontal
                showsHorizontalScrollIndicator={Platform.OS !== 'web'}
                nestedScrollEnabled={true}
                style={style.tableScrollView}
            >
                <View style={style.tableContent}>
                    {/* Render each column as a vertical container */}
                    {props.headers.map((header, colIndex) => (
                        <View
                            key={`column-${colIndex}`}
                            style={[
                                style.tableColumn,
                                colIndex === columnCount - 1 && style.tableColumnLast
                            ]}
                        >
                            {/* Header cell for this column */}
                            <View style={[style.tableCell, style.tableHeaderCell, style.tableCellFirst]}>
                                <Text style={style.tableHeaderText}><RenderSpans spans={header} baseStyle={style.tableHeaderText} onLinkPress={props.onLinkPress} selectable={props.selectable} /></Text>
                            </View>
                            {/* Data cells for this column */}
                            {props.rows.map((row, rowIndex) => (
                                <View
                                    key={`cell-${rowIndex}-${colIndex}`}
                                    style={[
                                        style.tableCell,
                                        isLastRow(rowIndex) && style.tableCellLast
                                    ]}
                                >
                                    <Text style={style.tableCellText}><RenderSpans spans={row[colIndex] ?? []} baseStyle={style.tableCellText} onLinkPress={props.onLinkPress} selectable={props.selectable} /></Text>
                                </View>
                            ))}
                        </View>
                    ))}
                </View>
            </ScrollView>
        </View>
    );
}


const style = StyleSheet.create((theme) => ({

    // Plain text

    text: {
        ...Typography.default(),
        fontSize: theme.typography.body.fontSize,
        lineHeight: theme.typography.body.lineHeight,
        marginTop: 8,
        marginBottom: 8,
        color: theme.colors.text,
        fontWeight: '400',
    },

    italic: {
        fontStyle: 'italic',
    },
    bold: {
        fontWeight: 'bold',
    },
    semibold: {
        fontWeight: '600',
    },
    code: {
        ...Typography.mono(),
        fontSize: theme.typography.code.fontSize,
        lineHeight: theme.typography.code.lineHeight,
        color: theme.colors.text,
    },
    strikethrough: {
        textDecorationLine: 'line-through',
    },
    link: {
        ...Typography.default(),
        color: theme.colors.text,
        fontWeight: '400',
        textDecorationLine: 'underline',
        cursor: 'pointer',
    },

    // Headers

    header: {
        ...Typography.default('semiBold'),
        color: theme.colors.text,
    },
    header1: {
        fontSize: theme.typography.title.fontSize,
        lineHeight: theme.typography.title.lineHeight,
        fontWeight: '600',
        marginTop: 24,
        marginBottom: 8
    },
    header2: {
        fontSize: theme.typography.heading.fontSize,
        lineHeight: theme.typography.heading.lineHeight,
        fontWeight: '600',
        marginTop: 20,
        marginBottom: 8
    },
    header3: {
        fontSize: theme.typography.subheading.fontSize,
        lineHeight: theme.typography.subheading.lineHeight,
        fontWeight: '600',
        marginTop: 16,
        marginBottom: 8,
    },
    header4: {
        fontSize: theme.typography.body.fontSize,
        lineHeight: theme.typography.body.lineHeight,
        fontWeight: '600',
        marginTop: 8,
        marginBottom: 8,
    },
    header5: {
        fontSize: theme.typography.body.fontSize,
        lineHeight: theme.typography.body.lineHeight,
        fontWeight: '600'
    },
    header6: {
        fontSize: theme.typography.body.fontSize,
        lineHeight: theme.typography.body.lineHeight,
        fontWeight: '600'
    },

    //
    // List
    //

    list: {
        ...Typography.default(),
        color: theme.colors.text,
        marginTop: 0,
        marginBottom: 0,
    },
    taskMarker: {
        width: 18,
        color: theme.colors.textSecondary,
    },

    //
    // Common
    //

    first: {
        // marginTop: 0
    },
    last: {
        // marginBottom: 0
    },

    //
    // Code Block
    //

    codeBlock: {
        backgroundColor: theme.colors.surfaceHighest,
        borderRadius: 8,
        marginVertical: 8,
        position: 'relative',
        zIndex: 1,
    },
    copyButtonWrapper: {
        position: 'absolute',
        top: 8,
        right: 8,
        opacity: 0,
        zIndex: 10,
        elevation: 10,
        pointerEvents: 'none',
    },
    copyButtonWrapperVisible: {
        opacity: 1,
        pointerEvents: 'auto',
    },
    codeLanguage: {
        ...Typography.mono(),
        color: theme.colors.textSecondary,
        fontSize: theme.typography.code.fontSize,
        marginTop: 8,
        paddingHorizontal: 16,
        marginBottom: 0,
    },
    codeText: {
        ...Typography.mono(),
        color: theme.colors.text,
        fontSize: theme.typography.code.fontSize,
        lineHeight: theme.typography.code.lineHeight,
    },
    horizontalRule: {
        height: 1,
        backgroundColor: theme.colors.divider,
        marginTop: 8,
        marginBottom: 8,
    },
    blockquote: {
        borderLeftWidth: 3,
        borderLeftColor: theme.colors.divider,
        paddingLeft: 12,
        marginVertical: 6,
        opacity: 0.9,
    },
    imageBlock: {
        width: '100%',
        maxWidth: 520,
        marginVertical: 8,
        alignSelf: 'flex-start',
        gap: 8,
    },
    image: {
        width: '100%',
        minHeight: 160,
        height: 240,
        borderRadius: 12,
        backgroundColor: theme.colors.surfaceHighest,
    },
    imageCaption: {
        ...Typography.default(),
        fontSize: theme.typography.label.fontSize,
        lineHeight: theme.typography.label.lineHeight,
        color: theme.colors.textSecondary,
    },
    copyButtonContainer: {
        position: 'absolute',
        top: 8,
        right: 8,
        zIndex: 10,
        elevation: 10,
        opacity: 1,
    },
    copyButtonContainerHidden: {
        opacity: 0,
    },
    copyButton: {
        minWidth: 44,
        minHeight: 44,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.surfaceHighest,
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 4,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        cursor: 'pointer',
    },
    copyButtonHidden: {
        display: 'none',
    },
    copyButtonCopied: {
        backgroundColor: theme.colors.success,
        borderColor: theme.colors.success,
        opacity: 1,
    },
    copyButtonText: {
        ...Typography.default(),
        color: theme.colors.text,
        fontSize: theme.typography.caption.fontSize,
        lineHeight: theme.typography.caption.lineHeight,
    },

    //
    // Options Block
    //

    optionsContainer: {
        flexDirection: 'column',
        gap: 8,
        marginVertical: 8,
    },
    optionItem: {
        backgroundColor: theme.colors.surfaceHighest,
        borderRadius: 8,
        paddingHorizontal: 16,
        paddingVertical: 12,
        borderWidth: 1,
        borderColor: theme.colors.divider,
    },
    optionItemPressed: {
        opacity: 0.7,
        backgroundColor: theme.colors.surfaceHigh,
    },
    optionText: {
        ...Typography.default(),
        fontSize: theme.typography.body.fontSize,
        lineHeight: theme.typography.body.lineHeight,
        color: theme.colors.text,
    },

    //
    // Table
    //

    tableContainer: {
        marginVertical: 8,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        borderRadius: 8,
        overflow: 'hidden',
        maxWidth: '100%',
        flexGrow: 0,
        flexShrink: 1,
    },
    tableScrollView: {
        flexGrow: 0,
        flexShrink: 1,
    },
    tableContent: {
        flexDirection: 'row',
    },
    tableColumn: {
        flexDirection: 'column',
        borderRightWidth: 1,
        borderRightColor: theme.colors.divider,
    },
    tableColumnLast: {
        borderRightWidth: 0,
    },
    tableCell: {
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.divider,
        alignItems: 'flex-start',
    },
    tableCellFirst: {
        borderTopWidth: 0,
    },
    tableCellLast: {
        borderBottomWidth: 0,
    },
    tableHeaderCell: {
        backgroundColor: theme.colors.surfaceHigh,
    },
    tableHeaderText: {
        ...Typography.default('semiBold'),
        color: theme.colors.text,
        fontSize: theme.typography.body.fontSize,
        lineHeight: theme.typography.body.lineHeight,
    },
    tableCellText: {
        ...Typography.default(),
        color: theme.colors.text,
        fontSize: theme.typography.body.fontSize,
        lineHeight: theme.typography.body.lineHeight,
    },

    // Add global style for Web platform (Unistyles supports this via compiler plugin)
    ...(Platform.OS === 'web' ? {
        // Web-only CSS styles
        _____web_global_styles: {}
    } : {}),
}));
