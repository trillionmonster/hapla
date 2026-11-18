import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error installed renderer lacks declarations
import { act, create } from 'react-test-renderer';

const mocks = vi.hoisted(() => ({ status: vi.fn(), start: vi.fn(), refresh: vi.fn(), machines: vi.fn() }));
vi.mock('@/sync/ops', () => ({
    machineCodexUpdateStatus: mocks.status,
    machineCodexUpdateStart: mocks.start,
    machineRefreshCliCapabilities: mocks.refresh,
}));
vi.mock('@/sync/sync', () => ({ sync: { refreshMachines: mocks.machines } }));
vi.mock('react-native', () => ({ ActivityIndicator: 'ActivityIndicator', Pressable: 'Pressable', Text: 'Text', View: 'View' }));
vi.mock('@expo/vector-icons/Ionicons', () => ({ default: 'Ionicons' }));
vi.mock('./ItemGroup', () => ({ ItemGroup: 'ItemGroup' }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('react-native-unistyles', async () => { const { typeScale: typography } = await import('@/constants/typeScale'); return ({
    useUnistyles: () => ({ theme: { typography,  colors: {} } }),
    StyleSheet: { create: (factory: any) => factory({ typography,  colors: {} }) },
}); });
import { MachineCodexUpdate } from './MachineCodexUpdate';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const response = (state: string, overrides: Record<string, unknown> = {}) => ({
    success: true,
    status: { state, message: `state: ${state}`, currentVersion: '1.0.0', updateSupported: true, ...overrides },
});

describe('machine Codex CLI update', () => {
    let tree: any;
    const render = async (props: Record<string, unknown> = {}) => {
        await act(async () => {
            const element = React.createElement(MachineCodexUpdate, { machineId: 'machine-a', online: true, metadata: null, ...props } as any);
            if (tree) tree.update(element);
            else tree = create(element);
        });
    };
    const button = (label: string) => tree.root.findAllByType('Pressable')
        .find((node: any) => node.props.accessibilityLabel === label);
    const text = () => JSON.stringify(tree.toJSON());
    const press = async (label: string) => {
        const target = button(label);
        expect(target).toBeDefined();
        expect(target.props.disabled).not.toBe(true);
        await act(async () => target.props.onPress());
    };
    beforeEach(() => {
        vi.useFakeTimers();
        mocks.status.mockReset().mockResolvedValue(response('idle'));
        mocks.start.mockReset().mockResolvedValue(response('checking', { operationId: 'job-a' }));
        mocks.refresh.mockReset().mockResolvedValue({ codex: { models: [{ code: 'reported' }] } });
        mocks.machines.mockReset().mockResolvedValue(undefined);
    });
    afterEach(async () => {
        if (tree) await act(async () => tree.unmount());
        tree = undefined;
        vi.useRealTimers();
    });

    it('starts once, polls every two seconds, synchronizes the catalog after completion and stops polling', async () => {
        await render();
        await press('更新 Codex CLI');
        expect(mocks.start).toHaveBeenCalledExactlyOnceWith('machine-a');
        expect(button('更新 Codex CLI').props.disabled).toBe(true);
        expect(button('刷新模型与档位').props.disabled).toBe(true);
        mocks.status.mockResolvedValueOnce(response('installing', { operationId: 'job-a' }))
            .mockResolvedValueOnce(response('completed', { operationId: 'job-a', currentVersion: '2.0.0', modelsRefreshed: true }));
        await act(async () => vi.advanceTimersByTimeAsync(1_999));
        expect(mocks.status).toHaveBeenCalledTimes(1);
        await act(async () => vi.advanceTimersByTimeAsync(1));
        expect(mocks.status).toHaveBeenCalledTimes(2);
        await act(async () => vi.advanceTimersByTimeAsync(2_000));
        expect(text()).toContain('v2.0.0');
        expect(mocks.machines).toHaveBeenCalledTimes(1);
        expect(button('更新 Codex CLI').props.disabled).toBe(false);
        await act(async () => vi.advanceTimersByTimeAsync(20_000));
        expect(mocks.status).toHaveBeenCalledTimes(3);
    });

    it('recovers a job when reopening the page and never cancels it on unmount', async () => {
        mocks.status.mockResolvedValue(response('installing', { operationId: 'job-existing' }));
        await render();
        expect(text()).toContain('安装中');
        await act(async () => tree.unmount());
        tree = undefined;
        await act(async () => vi.advanceTimersByTimeAsync(10_000));
        expect(mocks.status).toHaveBeenCalledTimes(1);
        await render();
        await act(async () => vi.advanceTimersByTimeAsync(2_000));
        expect(mocks.status).toHaveBeenCalledTimes(3);
        expect(mocks.start).not.toHaveBeenCalled();
    });

    it('shows lost acknowledgements as unknown state and retries reading instead of re-submitting an update', async () => {
        await render();
        mocks.start.mockRejectedValueOnce(new Error('Socket not connected'));
        await press('更新 Codex CLI');
        expect(text()).toContain('已提交的更新可能仍在运行');
        expect(button('更新 Codex CLI').props.disabled).toBe(true);
        mocks.status.mockResolvedValueOnce(response('installing', { operationId: 'job-a' }));
        await press('重新读取 Codex 更新状态');
        expect(text()).not.toContain('连接中断或请求超时');
        expect(text()).toContain('安装中');
        expect(mocks.start).toHaveBeenCalledTimes(1);
    });

    it('stops polling on connection errors, leaves an explicit retry, and recovers status', async () => {
        mocks.status.mockResolvedValueOnce(response('verifying')).mockRejectedValueOnce(new Error('RPC timeout'));
        await render();
        await act(async () => vi.advanceTimersByTimeAsync(2_000));
        expect(text()).toContain('状态待确认');
        expect(tree.root.findAllByType('ActivityIndicator')).toHaveLength(0);
        await act(async () => vi.advanceTimersByTimeAsync(20_000));
        expect(mocks.status).toHaveBeenCalledTimes(2);
        mocks.status.mockResolvedValueOnce(response('completed', { operationId: 'job-a' }));
        await press('重新读取 Codex 更新状态');
        expect(text()).toContain('已完成');
    });

    it('does not contact an offline machine and disables both update and model refresh', async () => {
        await render({ online: false });
        expect(mocks.status).not.toHaveBeenCalled();
        expect(button('更新 Codex CLI').props.disabled).toBe(true);
        expect(button('刷新模型与档位').props.disabled).toBe(true);
        expect(text()).toContain('机器离线');
        await render({ online: true });
        expect(mocks.status).toHaveBeenCalledExactlyOnceWith('machine-a');
    });

    it('keeps model refresh available for unsupported custom installations and explains why update is unavailable', async () => {
        mocks.status.mockResolvedValueOnce(response('idle', { updateSupported: false, installation: 'custom', unsupportedReason: '定制补丁版本，请使用原安装方式升级。' }));
        await render();
        expect(button('更新 Codex CLI').props.disabled).toBe(true);
        expect(text()).toContain('定制补丁版本');
        await press('刷新模型与档位');
        expect(mocks.refresh).toHaveBeenCalledExactlyOnceWith('machine-a');
        expect(text()).toContain('模型列表与档位说明已同步');
    });

    it('shows server failures without claiming success and allows another update attempt', async () => {
        mocks.status.mockResolvedValueOnce(response('failed', { error: '校验失败，已保留原版本' }));
        await render();
        expect(text()).toContain('校验失败，已保留原版本');
        expect(text()).toContain('重试更新');
        await press('更新 Codex CLI');
        expect(mocks.start).toHaveBeenCalledTimes(1);
        expect(mocks.machines).not.toHaveBeenCalled();
    });

    it('retries a failed catalog refresh without resubmitting the update job', async () => {
        await render();
        mocks.refresh.mockRejectedValueOnce(new Error('模型列表读取失败'));
        await press('刷新模型与档位');
        expect(text()).toContain('模型列表读取失败');
        expect(text()).not.toContain('模型列表与档位说明已同步');
        await press('重试同步模型与档位');
        expect(mocks.refresh).toHaveBeenCalledTimes(2);
        expect(mocks.start).not.toHaveBeenCalled();
        expect(text()).toContain('模型列表与档位说明已同步');
    });

    it('does not report synchronization success when the machine returned no Codex catalog', async () => {
        await render();
        mocks.refresh.mockResolvedValueOnce(null);
        await press('刷新模型与档位');
        expect(text()).toContain('尚未获取到 Codex 能力信息');
        expect(text()).not.toContain('模型列表与档位说明已同步');
    });

    it('does not publish an old machine response after navigating to another machine', async () => {
        let resolve!: (value: unknown) => void;
        mocks.status.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
        await render();
        await render({ machineId: 'machine-b' });
        await act(async () => resolve(response('installing', { currentVersion: 'stale-version' })));
        expect(text()).not.toContain('stale-version');
        await press('更新 Codex CLI');
        expect(mocks.start).toHaveBeenCalledExactlyOnceWith('machine-b');
    });

    it('renders machine-reported model and effort descriptions without substituting hardcoded descriptions', async () => {
        await render({ metadata: { cliCapabilities: { codex: { version: '1.0.0', models: [{
            code: 'gpt-custom', value: 'My remote model', description: 'Model help from app-server',
            supportedEffortLevels: ['low', 'high'], defaultEffortLevel: 'high',
            effortDescriptions: { low: 'Provider fast description', high: 'Provider detailed description' },
        }] } } } });
        expect(text()).not.toContain('Provider fast description');
        await press('模型与档位说明');
        expect(text()).toContain('My remote model');
        expect(text()).toContain('Model help from app-server');
        expect(text()).toContain('Provider fast description');
        expect(text()).toContain('Provider detailed description');
    });

    it('normalizes the CLI version output instead of displaying vcodex-cli', async () => {
        mocks.status.mockResolvedValueOnce(response('idle', { currentVersion: 'codex-cli 0.153.4' }));
        await render();
        expect(text()).toContain('v0.153.4');
        expect(text()).not.toContain('vcodex-cli');
    });
});
