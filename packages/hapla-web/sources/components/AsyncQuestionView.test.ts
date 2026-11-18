import React from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
// @ts-expect-error installed renderer lacks declarations
import { act, create } from 'react-test-renderer';
const calls = vi.hoisted(() => ({ send: vi.fn(), prepare: vi.fn(), navigate: vi.fn(), messages: [] as any[] }));
vi.mock('@/sync/sync', () => ({ sync: { sendMessage: calls.send } }));
vi.mock('@/sync/storage', () => ({ useSession: () => ({ id: 'session' }), useConversationMessages: () => ({ messages: calls.messages }) }));
vi.mock('@/hooks/useSessionContinuation', () => ({ useSessionContinuation: () => calls.prepare }));
vi.mock('@/hooks/useNavigateToSession', () => ({ useNavigateToSession: () => calls.navigate }));
vi.mock('react-native', () => ({ View: 'div', Text: 'span', Pressable: 'button', ActivityIndicator: 'spinner', TextInput: 'input' }));
vi.mock('react-native-unistyles', async () => { const { typeScale: typography } = await import('@/constants/typeScale');
    const token: any = new Proxy({}, { get: () => token });
    const theme = { typography,  colors: token };
    return { useUnistyles: () => ({ theme }), StyleSheet: { create: (style: any) => style(theme) } };
});
import { AsyncQuestionView } from './AsyncQuestionView';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const question = { id: 'provider-question', questions: [{ title: '继续吗？', options: ['继续', '停止'] }] };
beforeEach(() => { vi.resetAllMocks(); calls.messages = []; calls.prepare.mockResolvedValue('session'); calls.send.mockResolvedValue(undefined); });

it('renders clickable choices, preselects the first without sending, and submits only the explicit choice', async () => {
    let root: any;
    await act(async () => { root = create(React.createElement(AsyncQuestionView, { question, sessionId: 'session' })); });
    expect(root.root.findByProps({ accessibilityLabel: '继续' }).props.accessibilityState.checked).toBe(true);
    expect(calls.send).not.toHaveBeenCalled();
    await act(async () => root.root.findByProps({ accessibilityLabel: '停止' }).props.onPress());
    expect(calls.send).not.toHaveBeenCalled();
    await act(async () => root.root.findByProps({ accessibilityLabel: '发送回答' }).props.onPress());
    expect(calls.send).toHaveBeenCalledExactlyOnceWith('session', '继续吗？\n回答：停止', { source: 'question', asyncQuestionResponse: { id: question.id, answers: ['停止'] } });
    expect(JSON.stringify(root.toJSON())).toContain('已发送回答');
    await act(async () => root.unmount());
});

it('keeps custom answers editable after failure and sends all questions to the resumed session', async () => {
    const questions = { id: 'multi', questions: [question.questions[0], { title: '补充说明', options: null }] };
    let root: any;
    await act(async () => { root = create(React.createElement(AsyncQuestionView, { question: questions, sessionId: 'session' })); });
    expect(root.root.findByProps({ accessibilityLabel: '发送回答' }).props.disabled).toBe(true);
    await act(async () => root.root.findByProps({ accessibilityLabel: '问题 1 的自定义回答' }).props.onChangeText('稍后继续'));
    await act(async () => root.root.findByProps({ accessibilityLabel: '问题 2 的自定义回答' }).props.onChangeText('先检查数据'));
    calls.send.mockRejectedValueOnce(new Error('offline'));
    await act(async () => root.root.findByProps({ accessibilityLabel: '发送回答' }).props.onPress());
    expect(JSON.stringify(root.toJSON())).toContain('发送失败，请重试');
    expect(root.root.findByProps({ accessibilityLabel: '问题 1 的自定义回答' }).props.value).toBe('稍后继续');
    calls.prepare.mockResolvedValueOnce('resumed');
    await act(async () => root.root.findByProps({ accessibilityLabel: '发送回答' }).props.onPress());
    expect(calls.send).toHaveBeenLastCalledWith('resumed', '继续吗？\n回答：稍后继续\n\n补充说明\n回答：先检查数据', { source: 'question', asyncQuestionResponse: { id: 'multi', answers: ['稍后继续', '先检查数据'] } });
    expect(calls.navigate).toHaveBeenCalledWith('resumed');
    await act(async () => root.unmount());
});

it('restores the actual saved answer after reload instead of displaying the default choice', async () => {
    calls.messages = [{ kind: 'user-text', meta: { asyncQuestionResponse: { id: question.id, answers: ['停止'] } } }];
    let root: any;
    await act(async () => { root = create(React.createElement(AsyncQuestionView, { question, sessionId: 'session' })); });
    expect(JSON.stringify(root.toJSON())).toContain('已发送回答');
    expect(JSON.stringify(root.toJSON())).toContain('停止');
    expect(root.root.findAllByType('button')).toHaveLength(0);
    expect(calls.send).not.toHaveBeenCalled();
    await act(async () => root.unmount());
});
