import * as React from "react";
import { Platform, Pressable, View, Text } from "react-native";
import Ionicons from '@expo/vector-icons/Ionicons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { MarkdownView } from "./markdown/MarkdownView";
import { t } from '@/text';
import { Message, UserTextMessage, AgentTextMessage, AgentMediaMessage, ToolCallMessage } from "@/sync/typesMessage";
import { Metadata } from "@/sync/storageTypes";
import { layout } from "./layout";
import { ToolView } from "./tools/ToolView";
import { AgentEvent } from "@/sync/typesRaw";
import { sync } from '@/sync/sync';
import { Option } from './markdown/MarkdownView';
import type { WorkspaceMode } from '@/hooks/useWorkspaceMode';
import { MediaGallery } from './media/MediaGallery';
import { shouldShowToolInNormalMode } from './tools/toolVisibility';
import { Modal } from '@/modal';
import { sessionForkCodexThread } from '@/sync/ops';
import { isConversationAgentEvent } from '@/utils/sessionEvents';
import { useSession } from '@/sync/storage';
import { useSessionContinuation } from '@/hooks/useSessionContinuation';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { useGroupedArtifact } from './ArtifactPresentation';
import { formatMessageTime } from '@/utils/messageTime';

const AsyncQuestionView = React.lazy(() => import('./AsyncQuestionView').then((module) => ({ default: module.AsyncQuestionView })));

export const MessageView = (props: {
  message: Message;
  metadata: Metadata | null;
  sessionId: string;
  workspaceMode: WorkspaceMode;
  getMessageById?: (id: string) => Message | null;
  userOrdinal?: number;
  webHistoryAnchorKey?: string;
}) => {
  return (
    <View
      style={styles.messageContainer}
      renderToHardwareTextureAndroid={true}
      {...(Platform.OS === 'web' && props.webHistoryAnchorKey
        ? { dataSet: { haplaHistoryAnchor: props.webHistoryAnchorKey } }
        : {})}
    >
      <View style={styles.messageContent}>
        <RenderBlock
          message={props.message}
          metadata={props.metadata}
          sessionId={props.sessionId}
          workspaceMode={props.workspaceMode}
          getMessageById={props.getMessageById}
          userOrdinal={props.userOrdinal}
        />
      </View>
    </View>
  );
};

// RenderBlock function that dispatches to the correct component based on message kind
function RenderBlock(props: {
  message: Message;
  metadata: Metadata | null;
  sessionId: string;
  workspaceMode: WorkspaceMode;
  getMessageById?: (id: string) => Message | null;
  userOrdinal?: number;
}): React.ReactElement {
  switch (props.message.kind) {
    case 'user-text':
      return <UserTextBlock message={props.message} sessionId={props.sessionId} workspaceMode={props.workspaceMode} metadata={props.metadata} userOrdinal={props.userOrdinal} />;

    case 'agent-text':
      return <AgentTextBlock message={props.message} sessionId={props.sessionId} workspaceMode={props.workspaceMode} />;

    case 'agent-media':
      return <AgentMediaBlock message={props.message} />;

    case 'tool-call':
      return <ToolCallVisibilityBlock
        message={props.message}
        metadata={props.metadata}
        sessionId={props.sessionId}
        workspaceMode={props.workspaceMode}
        getMessageById={props.getMessageById}
      />;

    case 'agent-event':
      return isConversationAgentEvent(props.message.event)
        ? <AgentEventBlock event={props.message.event} metadata={props.metadata} />
        : <></>;


    default:
      // Exhaustive check - TypeScript will error if we miss a case
      const _exhaustive: never = props.message;
      throw new Error(`Unknown message kind: ${_exhaustive}`);
  }
}

function ToolCallVisibilityBlock(props: {
  message: ToolCallMessage;
  metadata: Metadata | null;
  sessionId: string;
  workspaceMode: WorkspaceMode;
  getMessageById?: (id: string) => Message | null;
}) {
  const visible = props.workspaceMode === 'coder' || shouldShowToolInNormalMode(props.message.tool);
  const [hasMounted, setHasMounted] = React.useState(visible);

  React.useEffect(() => {
    if (visible) setHasMounted(true);
  }, [visible]);

  // Live requests are pinned above the composer so long histories cannot hide
  // the controls. Resolved cards remain part of the conversation.
  if (props.message.tool.permission?.status === 'pending' || props.message.tool.permission?.status === 'submitting') return <></>;
  if (!hasMounted) return <></>;
  return (
    <View style={visible ? undefined : styles.hiddenToolCall}>
      <ToolCallBlock
        message={props.message}
        metadata={props.metadata}
        sessionId={props.sessionId}
        getMessageById={props.getMessageById}
      />
    </View>
  );
}

function AgentMediaBlock(props: { message: AgentMediaMessage }) {
  const grouped = useGroupedArtifact();
  return (
    <View style={[styles.agentMessageContainer, grouped && { marginHorizontal: 0, marginBottom: 0 }]}>
      <MediaGallery media={props.message.media.map(item => ({ ...item, previewRevision: String(props.message.createdAt) }))} />
      {!grouped && <MessageTimestamp createdAt={props.message.createdAt} label="回答" />}
    </View>
  );
}

function MessageTimestamp({ createdAt, label }: { createdAt: number; label: '提问' | '回答' }) {
  const time = formatMessageTime(createdAt);
  if (!time) return null;
  return <Text style={[styles.messageTimestamp, label === '提问' && { marginTop: 0 }]} accessibilityLabel={`${label}时间（当地时间）：${time}`}>
    {time}
  </Text>;
}

function UserTextBlock(props: {
  message: UserTextMessage;
  sessionId: string;
  workspaceMode: WorkspaceMode;
  metadata: Metadata | null;
  userOrdinal?: number;
}) {
  const { theme } = useUnistyles();
  const session = useSession(props.sessionId);
  const prepareSessionForEdit = useSessionContinuation(session);
  const navigateToSession = useNavigateToSession();
  const handleOptionPress = React.useCallback((option: Option) => {
    sync.sendMessage(props.sessionId, option.title, { source: 'option' });
  }, [props.sessionId]);
  const [editDraft, setEditDraft] = React.useState<string>();
  const editMessage = React.useCallback(async () => {
    const nextText = await Modal.prompt('从这里重新编辑', '原分支会保留，并创建一个新的 Codex 分支。', {
      defaultValue: editDraft ?? props.message.text,
      confirmText: '创建分支',
    });
    if (!nextText?.trim() || props.userOrdinal === undefined || props.userOrdinal < 0) return;
    try {
      const targetSessionId = await prepareSessionForEdit();
      const result = await sessionForkCodexThread(targetSessionId, {
        userOrdinal: props.userOrdinal,
        userText: props.message.text,
        forkMessageId: props.message.sourceMessageId ?? props.message.id,
        forkMessageCreatedAt: props.message.createdAt,
        label: nextText.trim().slice(0, 36),
      });
      setEditDraft(undefined);
      await sync.sendMessage(targetSessionId, nextText.trim(), { source: 'chat', branchId: result.branchId });
      if (targetSessionId !== props.sessionId) navigateToSession(targetSessionId);
    } catch (error) {
      setEditDraft(nextText);
      Modal.alert('无法创建分支', error instanceof Error ? error.message : String(error));
    }
  }, [editDraft, navigateToSession, prepareSessionForEdit, props.message.createdAt, props.message.id, props.message.sourceMessageId, props.message.text, props.sessionId, props.userOrdinal]);

  return (
    <View style={styles.userMessageContainer}>
      <View style={styles.userMessageCluster}>
        <View style={styles.userMessageBubble}>
          {props.message.images && props.message.images.length > 0 && (
            <MediaGallery media={props.message.images} />
          )}
          {props.message.text ? (
            <MarkdownView
              markdown={props.message.displayText || props.message.text}
              onOptionPress={handleOptionPress}
              sessionId={props.sessionId}
              showCode={true}
            />
          ) : null}
        </View>
        <View style={styles.userMessageFooter}>
          <MessageTimestamp createdAt={props.message.createdAt} label="提问" />
          {props.message.meta?.codexInputId && <Text style={{ fontSize: 11, color: theme.colors.textSecondary }}>{({ queued: '已排队', submitting: '正在补充', running: '处理中', steered: '已加入当前任务', completed: '已完成', interrupted: '已停止', canceled: '已从队列移除', failed: '提交失败，可在队列重试' } as Record<string, string>)[session?.agentState?.codexInputs?.receipts?.find(receipt => receipt.id === props.message.meta?.codexInputId)?.status ?? ''] ?? '已提交'}</Text>}
          {props.metadata?.flavor === 'codex' ? (
            <Pressable accessibilityRole="button" accessibilityLabel="从这条消息重新编辑并保留原分支" onPress={editMessage}
              {...(Platform.OS === 'web' ? { title: '从这条消息重新编辑并保留原分支' } : {})}
              style={({ pressed }) => [styles.editButton, pressed && { backgroundColor: theme.colors.surfacePressed }]}>
              <Ionicons name="git-branch-outline" size={14} color={theme.colors.textSecondary} />
            </Pressable>
          ) : null}
        </View>
      </View>
    </View>
  );
}

function AgentTextBlock(props: {
  message: AgentTextMessage;
  sessionId: string;
  workspaceMode: WorkspaceMode;
}) {
  const handleOptionPress = React.useCallback((option: Option) => {
    sync.sendMessage(props.sessionId, option.title, { source: 'option' });
  }, [props.sessionId]);

  if (props.message.meta?.reasoningSummary) return <ReasoningSummaryBlock message={props.message} sessionId={props.sessionId} />;
  // Only explicitly public protocol summaries may be displayed.
  if (props.message.isThinking) {
    return null;
  }

  if (props.message.meta?.asyncQuestion) return (
    <View style={styles.agentMessageContainer}>
      <React.Suspense fallback={<Text>{props.message.text}</Text>}>
        <AsyncQuestionView question={props.message.meta.asyncQuestion} sessionId={props.sessionId} />
      </React.Suspense>
      <MessageTimestamp createdAt={props.message.createdAt} label="回答" />
    </View>
  );

  return (
    <View style={styles.agentMessageContainer}>
      <MarkdownView
        markdown={props.message.text}
        onOptionPress={handleOptionPress}
        sessionId={props.sessionId}
        showCode={true}
      />
      <MessageTimestamp createdAt={props.message.createdAt} label="回答" />
    </View>
  );
}

function ReasoningSummaryBlock({ message, sessionId }: { message: AgentTextMessage; sessionId: string }) {
  const [expanded, setExpanded] = React.useState(false);
  if (!message.text.trim()) return null;
  return <View style={styles.reasoningSummary}>
    <Pressable accessibilityRole="button" accessibilityLabel="推理摘要" accessibilityState={{ expanded }} onPress={() => setExpanded((value) => !value)} style={styles.summaryHeader}>
      <Ionicons name={expanded ? 'chevron-down' : 'chevron-forward'} size={16} />
      <Text style={styles.summaryTitle}>推理摘要{message.provisional ? ' · 更新中' : ''}</Text>
    </Pressable>
    {expanded && <MarkdownView markdown={message.text} sessionId={sessionId} showCode={true} />}
  </View>;
}

function AgentEventBlock(props: {
  event: AgentEvent;
  metadata: Metadata | null;
}) {
  if (props.event.type === 'switch') {
    return (
      <View style={styles.agentEventContainer}>
        <Text style={styles.agentEventText}>{t('message.switchedToMode', { mode: props.event.mode })}</Text>
      </View>
    );
  }
  if (props.event.type === 'message') {
    return (
      <View style={styles.agentEventContainer}>
        <Text style={styles.agentEventText}>{props.event.message}</Text>
      </View>
    );
  }
  if (props.event.type === 'limit-reached') {
    const formatTime = (timestamp: number): string => {
      try {
        const date = new Date(timestamp * 1000); // Convert from Unix timestamp
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      } catch {
        return t('message.unknownTime');
      }
    };

    return (
      <View style={styles.agentEventContainer}>
        <Text style={styles.agentEventText}>
          {t('message.usageLimitUntil', { time: formatTime(props.event.endsAt) })}
        </Text>
      </View>
    );
  }
  return (
    <View style={styles.agentEventContainer}>
      <Text style={styles.agentEventText}>{t('message.unknownEvent')}</Text>
    </View>
  );
}

function ToolCallBlock(props: {
  message: ToolCallMessage;
  metadata: Metadata | null;
  sessionId: string;
  getMessageById?: (id: string) => Message | null;
}) {
  const grouped = useGroupedArtifact();
  if (!props.message.tool) {
    return null;
  }
  return (
    <View style={[styles.toolContainer, grouped && { marginHorizontal: 0 }]}>
      <ToolView
        tool={props.message.tool}
        metadata={props.metadata}
        messages={props.message.children}
        sessionId={props.sessionId}
        messageId={props.message.id}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  messageContainer: {
    flexDirection: 'row',
    justifyContent: 'center',
  },
  messageContent: {
    flexDirection: 'column',
    flexGrow: 1,
    flexBasis: 0,
    minWidth: 0,
    maxWidth: layout.maxWidth,
    overflow: 'hidden',
  },
  userMessageContainer: {
    maxWidth: '100%',
    flexDirection: 'column',
    alignItems: 'flex-end',
    justifyContent: 'flex-end',
    paddingHorizontal: 16,
  },
  userMessageBubble: {
    backgroundColor: theme.colors.userMessageBackground,
    paddingHorizontal: 15,
    paddingVertical: 7,
    borderRadius: 18,
    maxWidth: '100%',
  },
  userMessageCluster: {
    maxWidth: '88%',
    minWidth: 0,
    alignItems: 'flex-end',
    marginBottom: 14,
  },
  userMessageFooter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 6, marginTop: 2 },
  editButton: { alignItems: 'center', justifyContent: 'center', width: 44, height: 44, borderRadius: 10 },
  messageTimestamp: {
    color: theme.colors.textSecondary,
    fontSize: theme.typography.caption.fontSize,
    lineHeight: theme.typography.caption.lineHeight,
    marginTop: 6,
    fontVariant: ['tabular-nums'],
  },
  reasoningSummary: { marginHorizontal: 16, marginBottom: 12, padding: 12, borderRadius: 12, backgroundColor: theme.colors.surfaceHigh },
  summaryHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44 },
  summaryTitle: { color: theme.colors.textSecondary, fontSize: theme.typography.small.fontSize },
  agentMessageContainer: {
    marginHorizontal: 16,
    marginBottom: 18,
    borderRadius: 16,
  },
  agentEventContainer: {
    marginHorizontal: 8,
    alignItems: 'center',
    paddingVertical: 8,
  },
  agentEventText: {
    color: theme.colors.agentEventText,
    fontSize: theme.typography.label.fontSize,
  },
  toolContainer: {
    marginHorizontal: 8,
  },
  hiddenToolCall: {
    display: 'none',
  },
  debugText: {
    color: theme.colors.agentEventText,
    fontSize: theme.typography.caption.fontSize,
  },
}));
