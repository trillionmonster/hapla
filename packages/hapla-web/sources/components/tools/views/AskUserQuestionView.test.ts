import React from 'react';
import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error installed renderer lacks declarations
import { act, create } from 'react-test-renderer';
const call = vi.hoisted(() => ({ allow: vi.fn() }));
vi.mock('@/sync/ops', () => ({ sessionAllow: call.allow }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@expo/vector-icons/Ionicons', () => ({ default: 'icon' }));
vi.mock('../ToolSectionView', () => ({ ToolSectionView: 'section' }));
vi.mock('react-native', () => ({ View: 'div', Text: 'span', TouchableOpacity: 'button', ActivityIndicator: 'spinner', TextInput: 'input' }));
vi.mock('react-native-unistyles', async () => { const { typeScale: typography } = await import('@/constants/typeScale');
    const token: any = new Proxy({}, { get: () => token });
    const theme = { typography,  colors: token };
    return { useUnistyles: () => ({ theme }), StyleSheet: { create: (style: any) => style(theme) } };
});
import { AskUserQuestionView } from './AskUserQuestionView';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

it('keeps a failed secret answer editable, waits after RPC acknowledgement, then masks the resolved view', async () => {
    let permission: any = { id: 'request', status: 'pending' };
    const tool: any = { name: 'AskUserQuestion', state: 'running', input: { answerFormat: 'codex', questions: [{ id: 'password', header: 'Secret', question: 'Enter token', options: [], multiSelect: false, isSecret: true }] } };
    const element = () => React.createElement(AskUserQuestionView, { tool: { ...tool, permission }, sessionId: 'session' } as any);
    let root: any; await act(async () => { root = create(element()); });
    const input = () => root.root.findByType('input');
    await act(async () => input().props.onChangeText('secret-never-echo'));
    call.allow.mockRejectedValueOnce(new Error('network transport failed'));
    await act(async () => root.root.findByType('button').props.onPress());
    expect(input().props.value).toBe('secret-never-echo');
    expect(JSON.stringify(root.toJSON())).toContain('提交失败，请重试');
    call.allow.mockResolvedValueOnce({ ok: true });
    await act(async () => root.root.findByType('button').props.onPress());
    expect(JSON.stringify(root.toJSON())).toContain('等待 Codex 确认');
    expect(JSON.stringify(root.toJSON())).not.toContain('secret-never-echo');
    expect(call.allow).toHaveBeenLastCalledWith('session', 'request', undefined, undefined, 'approved', { answers: { password: { answers: ['secret-never-echo'] } } });
    permission = { ...permission, status: 'approved', providerStatus: 'resolved' };
    await act(async () => root.update(element()));
    expect(JSON.stringify(root.toJSON())).toContain('已隐藏');
    expect(JSON.stringify(root.toJSON())).not.toContain('secret-never-echo');
    await act(async () => root.unmount());
});

it('submits a single Codex choice with one click and preserves its question ID', async () => {
    call.allow.mockResolvedValueOnce({ ok: true });
    const tool: any = { name: 'AskUserQuestion', state: 'running', permission: { id: 'click', status: 'pending' }, input: { answerFormat: 'codex', questions: [{ id: 'decision', header: '选择', question: '继续吗？', multiSelect: false, options: [{ label: '继续', description: '开始执行' }] }] } };
    let root: any; await act(async () => { root = create(React.createElement(AskUserQuestionView, { tool, sessionId: 'session' } as any)); });
    await act(async () => root.root.findByProps({ accessibilityLabel: '继续' }).props.onPress());
    expect(call.allow).toHaveBeenLastCalledWith('session', 'click', undefined, undefined, 'approved', { answers: { decision: { answers: ['继续'] } } });
    expect(JSON.stringify(root.toJSON())).toContain('等待 Codex 确认');
    await act(async () => root.unmount());
});

it('accepts a later rehydrated question without changing hook order', async () => {
    const tool: any = { state: 'running', input: {}, permission: { id: 'hydrate', status: 'pending' } };
    let root: any;
    await act(async () => { root = create(React.createElement(AskUserQuestionView, { tool, sessionId: 'session' } as any)); });
    await act(async () => root.update(React.createElement(AskUserQuestionView, { tool: { ...tool, input: { questions: [{ question: 'Restored', header: 'Choice', options: [], multiSelect: false }] } }, sessionId: 'session' } as any)));
    expect(JSON.stringify(root.toJSON())).toContain('Restored');
    await act(async () => root.unmount());
});

it('renders the authoritative expired state without leaving interactive controls', async () => {
    const tool: any = {
        name: 'AskUserQuestion',
        state: 'error',
        input: {
            autoResolutionMs: 1_000,
            expiresAt: 1_001,
            questions: [{ id: 'choice', question: 'Pick one', header: 'Choice', options: [], multiSelect: false }],
        },
        permission: { id: 'expired-request', status: 'expired', providerStatus: 'resolved' },
    };
    let root: any;
    await act(async () => { root = create(React.createElement(AskUserQuestionView, { tool, sessionId: 'session' } as any)); });
    const rendered = JSON.stringify(root.toJSON());
    expect(rendered).toContain('已超时');
    expect(rendered).not.toContain('已取消');
    expect(root.root.findAllByType('button')).toHaveLength(0);
    expect(root.root.findAllByType('input')).toHaveLength(0);
    await act(async () => root.unmount());
});
