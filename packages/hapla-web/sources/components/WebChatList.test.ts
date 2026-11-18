import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error installed renderer lacks declarations
import { act, create } from 'react-test-renderer';
import type { Message, ToolCallMessage } from '@/sync/typesMessage';
import type { ForwardScrollViewportProps } from './ForwardScrollViewport';

const fixture = vi.hoisted(() => ({
    viewport: undefined as ForwardScrollViewportProps | undefined,
    pages: {} as Record<string, unknown>,
    loadOlder: vi.fn(),
    returnToLatest: vi.fn(),
    scrollToLatest: vi.fn(),
    restoreAnchor: vi.fn(),
    getRowsHeight: vi.fn(),
    saveAnchor: vi.fn(),
}));

vi.mock('react-native', () => ({ View: 'View', Pressable: 'Pressable', Platform: { OS: 'web' } }));
vi.mock('./layout', () => ({ layout: { maxWidth: 800 } }));
vi.mock('@expo/vector-icons/Ionicons', () => ({ default: 'Icon' }));
vi.mock('react-native-unistyles', async () => { const { typeScale: typography } = await import('@/constants/typeScale'); return ({
    useUnistyles: () => ({ theme: { typography,  colors: { textSecondary: '#aaa', surfaceHigh: '#222', fab: { background: '#333', icon: '#fff' } } } }),
}); });
vi.mock('./StyledText', () => ({ Text: 'Text' }));
vi.mock('./MessageView', () => ({ MessageView: 'MessageView' }));
vi.mock('./ChatFooter', () => ({ ChatFooter: 'ChatFooter' }));
vi.mock('./CodexBranchBar', () => ({ CodexBranchBar: 'CodexBranchBar' }));
vi.mock('@/modal', () => ({ Modal: { alert: vi.fn() } }));
vi.mock('@/sync/storage', () => ({
    storage: { getState: () => ({ sessionMessages: fixture.pages, sessionViewStates: {}, saveSessionScrollAnchor: fixture.saveAnchor }) },
    useSession: () => ({ agentState: {} }),
    messageSignature: (message: Message) => JSON.stringify([message.kind, message.createdAt,
        'text' in message ? message.text : message.kind === 'tool-call' ? [message.tool.name, message.tool.input] : message]),
}));
vi.mock('@/sync/sync', () => ({ sync: {
    loadOlderConversationMessages: fixture.loadOlder,
    readConversationHistoryPage: async (ids: string[]) => {
        const advanced = await fixture.loadOlder(ids);
        if (!advanced) throw new Error('History cursor did not advance');
        return { sessionId: ids[0], messages: [], next: { sessionId: ids[0], before: 1000 - fixture.loadOlder.mock.calls.length } };
    },
    returnToLatestConversationMessages: fixture.returnToLatest,
} }));
vi.mock('./ForwardScrollViewport', async () => {
    const React = await import('react');
    return {
        ForwardScrollViewport: React.forwardRef((props: ForwardScrollViewportProps, ref) => {
            fixture.viewport = props;
            React.useImperativeHandle(ref, () => ({ scrollToLatest: fixture.scrollToLatest, restoreAnchor: fixture.restoreAnchor, getRowsHeight: fixture.getRowsHeight }));
            return React.createElement('Viewport', null, props.children);
        }),
    };
});

import { WebChatList } from './WebChatList';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const textMessage = (index: number): Message => ({
    kind: 'agent-text', id: `message-${index}`, localId: null, createdAt: index + 1000, text: `Paragraph ${index}`,
});
const toolMessage = (status: 'pending' | 'approved' = 'approved'): ToolCallMessage => ({
    kind: 'tool-call', id: 'tool', localId: null, createdAt: 1002, children: [],
    tool: { name: 'Bash', input: { command: 'true' }, state: 'running', createdAt: 1002,
        startedAt: 1002, completedAt: null, description: null, permission: { id: 'approval', status } },
});
const deferred = () => {
    let resolve!: (value?: boolean) => void;
    const promise = new Promise<boolean | undefined>((done) => { resolve = done; });
    return { promise, resolve };
};

describe('WebChatList reading lifecycle', () => {
    let root: any;
    let props: React.ComponentProps<typeof WebChatList>;

    const render = async (patch: Partial<React.ComponentProps<typeof WebChatList>> = {}) => {
        props = { ...props, ...patch };
        props.messages = [...props.messages].sort((a, b) => b.createdAt - a.createdAt);
        fixture.pages = {
            session: {
                messagesMap: Object.fromEntries(props.messages.map((message) => [message.id, message])),
                rawMessagesMap: Object.fromEntries(props.messages.map((message) => [`raw-${message.id}`, { seq: message.createdAt }])),
                reducerState: { messages: new Map(props.messages.map((message) => [message.id, { realID: `raw-${message.id}` }])) },
            },
        };
        await act(async () => {
            const element = React.createElement(WebChatList, props);
            if (root) root.update(element);
            else root = create(element);
        });
    };
    const renderedMessages = (): Message[] => root.root.findAllByType('MessageView').map((node: any) => node.props.message);
    const renderedIds = (): string[] => renderedMessages().map((message) => message.id);
    const rowKey = (messageId: string): string => root.root.findAllByType('div').find((node: any) =>
        node.props['data-hapla-forward-row'] && node.findByType('MessageView').props.message.id === messageId).props['data-hapla-forward-row'];
    const positionAt = async (messageId: string) => {
        const key = rowKey(messageId);
        await act(async () => { fixture.viewport!.onPosition!({ anchorId: key, distanceFromBottom: 400, scrollTop: 300, anchorViewportTop: -20 }); });
    };
    const beginTouch = async () => {
        await act(async () => { fixture.viewport!.onGestureStart!(); fixture.viewport!.onInteractionChange!(true); });
    };
    const endTouch = async () => {
        await act(async () => { fixture.viewport!.onGestureEnd!(); fixture.viewport!.onInteractionChange!(false); });
    };
    const requestOlder = async () => {
        await act(async () => { fixture.viewport!.onGestureStart!(); fixture.viewport!.onHistoryIntent!(); });
    };
    const clickLatest = async () => {
        const button = root.root.findAllByType('Pressable').find((node: any) => node.props.accessibilityLabel === '返回最新消息');
        expect(button).toBeDefined();
        await act(async () => { button.props.onPress(); });
    };

    beforeEach(() => {
        fixture.viewport = undefined;
        fixture.pages = {};
        fixture.loadOlder.mockReset().mockResolvedValue(false);
        fixture.returnToLatest.mockReset().mockResolvedValue(undefined);
        fixture.scrollToLatest.mockReset();
        fixture.restoreAnchor.mockReset();
        fixture.getRowsHeight.mockReset().mockReturnValue(0);
        fixture.saveAnchor.mockReset();
        props = { sessionId: 'session', conversationSessionIds: ['session'], metadata: null,
            messages: [textMessage(1), textMessage(2)], hasOlder: true, hasNewer: false,
            isLoadingOlder: false, isLoadingLatest: false, workspaceMode: 'normal', onSwitchBranch: vi.fn() };
    });
    afterEach(async () => {
        if (root) await act(async () => root.unmount());
        root = undefined;
    });

    it('keeps current rendered rows through a touch response and commits the older page after release', async () => {
        await render();
        await positionAt('message-1');
        await beginTouch();
        await render({ messages: [textMessage(0), textMessage(1), textMessage(2)] });
        expect(renderedIds()).toEqual(['message-1', 'message-2']);
        await endTouch();
        expect(renderedIds()).toEqual(['message-0', 'message-1', 'message-2']);
    });

    it('retains the visible part of a full window until the user reaches a row shared with the older page', async () => {
        const old = Array.from({ length: 600 }, (_, index) => textMessage(index));
        await render({ messages: old });
        await positionAt('message-590');
        await beginTouch();
        await act(async () => { fixture.viewport!.onHistoryIntent!(); });
        fixture.loadOlder.mockClear();
        await render({ messages: [...Array.from({ length: 80 }, (_, index) => textMessage(index - 80)), ...old.slice(0, 520)], hasNewer: true });
        await endTouch();
        expect(renderedIds()).toHaveLength(600);
        expect(renderedIds()).toContain('message-590');
        expect(renderedIds()).not.toContain('message--80');
        await requestOlder();
        expect(fixture.loadOlder).not.toHaveBeenCalled();
        await positionAt('message-500');
        expect(renderedIds()).toHaveLength(600);
        expect(renderedIds()).toContain('message--80');
        expect(renderedIds()).not.toContain('message-590');
    });

    it('applies Coder to Normal filtering even when the reading anchor is a hidden tool', async () => {
        await render({ messages: [textMessage(1), toolMessage()], workspaceMode: 'coder' });
        await positionAt('tool');
        await render({ workspaceMode: 'normal' });
        expect(renderedIds()).toEqual(['message-1']);
        expect(root.root.findByType('MessageView').props.workspaceMode).toBe('normal');
    });

    it('restores the Normal reading position after visiting a different Coder raw window', async () => {
        await render();
        await positionAt('message-1');
        const key = rowKey('message-1');
        await render({ workspaceMode: 'coder', messages: [textMessage(20), toolMessage()] });
        await positionAt('message-20');
        await render({ workspaceMode: 'normal' });
        expect(fixture.restoreAnchor).toHaveBeenLastCalledWith({ id: key, viewportTop: -20, distanceFromBottom: 400 });
        expect(renderedIds()).toContain('message-1');
    });

    it('isolates a touched permission card from shared mutation, then hides it after approval and release', async () => {
        const tool = toolMessage('pending');
        await render({ messages: [textMessage(1), tool] });
        await positionAt('tool');
        await beginTouch();
        tool.tool.permission!.status = 'approved';
        await render({ messages: [textMessage(1), tool] });
        expect((renderedMessages().find((message) => message.id === 'tool') as ToolCallMessage).tool.permission?.status).toBe('pending');
        await endTouch();
        expect(renderedIds()).toEqual(['message-1']);
    });

    it('requests latest synchronization when an older page is in flight even before hasNewer becomes true', async () => {
        const pending = deferred();
        fixture.returnToLatest.mockReturnValue(pending.promise);
        await render({ isLoadingOlder: true, hasNewer: false });
        await positionAt('message-1');
        await clickLatest();
        expect(fixture.returnToLatest).toHaveBeenCalledExactlyOnceWith(['session'], 'session');
        await act(async () => { pending.resolve(); });
    });

    it('keeps a retained reading window until the requested latest page has finished loading', async () => {
        const pending = deferred();
        fixture.returnToLatest.mockReturnValue(pending.promise);
        await render();
        await positionAt('message-2');
        await render({ messages: [textMessage(0), textMessage(1)], hasNewer: true });
        await clickLatest();
        expect(renderedIds()).toContain('message-2');
        expect(fixture.scrollToLatest).not.toHaveBeenCalled();
        await render({ messages: [textMessage(20), textMessage(21)], hasNewer: false, isLoadingLatest: true });
        expect(renderedIds()).toContain('message-2');
        expect(fixture.scrollToLatest).not.toHaveBeenCalled();
        await act(async () => { pending.resolve(); });
        await render({ isLoadingLatest: false });
        expect(renderedIds()).toEqual(['message-20', 'message-21']);
        expect(fixture.scrollToLatest).toHaveBeenCalledTimes(1);
    });

    it('fills a short visible reply through more than three tool pages and stops at measured height', async () => {
        let pending = deferred();
        fixture.loadOlder.mockImplementation(() => pending.promise);
        await render({ messages: [textMessage(1), toolMessage()] });
        await act(async () => { fixture.viewport!.onLayout!({ viewportHeight: 600, rowsHeight: 60 }); });
        expect(fixture.loadOlder).toHaveBeenCalledTimes(1);
        for (let page = 1; page <= 5; page += 1) {
            await render({ isLoadingOlder: true });
            const completed = pending;
            pending = deferred();
            await act(async () => { completed.resolve(true); });
            await render({ isLoadingOlder: false });
            expect(fixture.loadOlder).toHaveBeenCalledTimes(page + 1);
        }
        await act(async () => { fixture.viewport!.onLayout!({ viewportHeight: 600, rowsHeight: 900 }); pending.resolve(true); });
        await render();
        expect(fixture.loadOlder).toHaveBeenCalledTimes(6);
        expect(renderedIds()).toContain('message-1');
    });

    it('does not repeatedly fetch when the raw cursor fails to advance', async () => {
        await render({ messages: [textMessage(1)] });
        await act(async () => { fixture.viewport!.onLayout!({ viewportHeight: 600, rowsHeight: 60 }); });
        expect(fixture.loadOlder).toHaveBeenCalledTimes(1);
        await render();
        await act(async () => { fixture.viewport!.onLayout!({ viewportHeight: 650, rowsHeight: 60 }); });
        expect(fixture.loadOlder).toHaveBeenCalledTimes(1);
        const retry = root.root.findAllByType('button').find((node: any) => node.children.includes('加载失败，点击重试'));
        expect(retry).toBeDefined();
        await act(async () => { retry.props.onClick(); });
        expect(fixture.loadOlder).toHaveBeenCalledTimes(2);
    });

    it('continues a single history gesture through hidden pages even when the viewport is already full', async () => {
        let pending = deferred();
        fixture.loadOlder.mockImplementation(() => pending.promise);
        await render();
        await act(async () => { fixture.viewport!.onLayout!({ viewportHeight: 600, rowsHeight: 1000 }); });
        await requestOlder();
        expect(fixture.loadOlder).toHaveBeenCalledTimes(1);
        for (let page = 1; page <= 4; page += 1) {
            const completed = pending;
            pending = deferred();
            await act(async () => { completed.resolve(true); });
            expect(fixture.loadOlder).toHaveBeenCalledTimes(page + 1);
        }
        await render({ messages: [textMessage(0), textMessage(1), textMessage(2)] });
        fixture.getRowsHeight.mockReturnValue(1200);
        await act(async () => { pending.resolve(true); });
        expect(fixture.loadOlder).toHaveBeenCalledTimes(5);
        expect(renderedIds()).toContain('message-0');
    });

    it('loads twenty short visible rows instead of stopping at the first row or at a prepend scroll correction', async () => {
        let pending = deferred();
        fixture.loadOlder.mockImplementation(() => pending.promise);
        await render();
        await act(async () => { fixture.viewport!.onLayout!({ viewportHeight: 600, rowsHeight: 1000 }); });
        await requestOlder();
        for (let count = 1; count <= 20; count += 1) {
            const completed = pending;
            pending = deferred();
            fixture.getRowsHeight.mockReturnValue(count * 40);
            await render({ messages: [...Array.from({ length: count }, (_, i) => textMessage(-i)), textMessage(1), textMessage(2)] });
            // This is the programmatic placement that follows a prepend, not
            // a physical scroll. Passing the old 240px edge must not cancel.
            await act(async () => { fixture.viewport!.onPosition!({ scrollTop: 300 + count * 40, distanceFromBottom: 400 }); });
            await act(async () => { completed.resolve(true); });
            expect(fixture.loadOlder).toHaveBeenCalledTimes(Math.min(count + 1, 20));
        }
        expect(renderedIds()).toHaveLength(22);
    });

    it('finishes a long-message batch after two viewport heights without demanding twenty long messages', async () => {
        const pending = deferred();
        fixture.loadOlder.mockReturnValue(pending.promise);
        await render();
        await act(async () => { fixture.viewport!.onLayout!({ viewportHeight: 500, rowsHeight: 1000 }); });
        await requestOlder();
        fixture.getRowsHeight.mockReturnValue(1000);
        await render({ messages: [textMessage(0), textMessage(1), textMessage(2), textMessage(99)] });
        await act(async () => { pending.resolve(true); });
        expect(fixture.loadOlder).toHaveBeenCalledTimes(1);
        expect([...fixture.getRowsHeight.mock.calls.at(-1)![0]]).toEqual([rowKey('message-0')]);
    });

    it('keeps the batch through another touch and pauses follow-up requests until release', async () => {
        const pending = deferred();
        fixture.loadOlder.mockReturnValue(pending.promise);
        await render();
        await requestOlder();
        await beginTouch();
        await render({ messages: [textMessage(0), textMessage(1), textMessage(2)] });
        fixture.loadOlder.mockResolvedValue(false);
        await act(async () => { pending.resolve(true); });
        expect(fixture.loadOlder).toHaveBeenCalledTimes(1);
        await endTouch();
        expect(fixture.loadOlder).toHaveBeenCalledTimes(2);
    });

    it('cancels a partial batch when the user physically scrolls toward newer messages', async () => {
        const pending = deferred();
        fixture.loadOlder.mockReturnValue(pending.promise);
        await render();
        await requestOlder();
        await render({ messages: [textMessage(0), textMessage(1), textMessage(2)] });
        await act(async () => { fixture.viewport!.onUserScroll!({ scrollTop: 400, previousScrollTop: 300 }); pending.resolve(true); });
        expect(fixture.loadOlder).toHaveBeenCalledTimes(1);
    });

    it('pauses underfill requests while touching and stops when history is exhausted', async () => {
        await render({ messages: [textMessage(1)] });
        await beginTouch();
        await act(async () => { fixture.viewport!.onLayout!({ viewportHeight: 600, rowsHeight: 60 }); });
        expect(fixture.loadOlder).not.toHaveBeenCalled();
        await render({ hasOlder: false });
        await endTouch();
        expect(fixture.loadOlder).not.toHaveBeenCalled();
    });

    it('retains visible conversation across raw tool-window eviction without pinning an obsolete window', async () => {
        await render({ messages: [textMessage(10), toolMessage()] });
        await positionAt('message-10');
        await render({ messages: [toolMessage()], hasNewer: true });
        expect(renderedIds()).toEqual(['message-10']);
        await render({ messages: [textMessage(1), toolMessage()], hasNewer: true });
        expect(renderedIds()).toEqual(['message-1', 'message-10']);
        await requestOlder();
        expect(fixture.loadOlder).toHaveBeenCalledTimes(1);
    });
});
