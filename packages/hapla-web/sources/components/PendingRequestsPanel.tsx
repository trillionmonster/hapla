import * as React from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import type { Session } from '@/sync/storageTypes';
import { ToolView } from './tools/ToolView';

export function PendingRequestsPanel({ session }: { session: Session }) {
    const { theme } = useUnistyles();
    const threadId = session.metadata?.codexThreadId;
    const requests = Object.entries(session.agentState?.requests ?? {}).filter(([id, request]) =>
        !session.agentState?.completedRequests?.[id] && (!request.protocol?.threadId || !threadId || request.protocol.threadId === threadId));
    if (!requests.length) return null;
    return <View style={{ maxHeight: 340, borderTopWidth: 1, borderTopColor: theme.colors.divider }}>
        <Text accessibilityLiveRegion="polite" style={{ padding: 8, color: theme.colors.text, fontWeight: '600' }}>等待你的选择 · {requests.length}</Text>
        <ScrollView style={{ flexShrink: 1 }}>
            {requests.map(([id, request]) => <ToolView key={id} sessionId={session.id} metadata={session.metadata} tool={{
                name: request.tool, state: 'running', input: request.arguments, createdAt: request.createdAt ?? Date.now(), startedAt: null, completedAt: null, description: null, result: undefined,
                permission: { id, status: request.status ?? 'pending', protocol: request.protocol, submittedAt: request.submittedAt },
            }} />)}
        </ScrollView>
    </View>;
}
