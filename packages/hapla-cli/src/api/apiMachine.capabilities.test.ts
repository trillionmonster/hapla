import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MachineMetadata } from './types';

const discovery = vi.hoisted(() => ({
    codexVersion: vi.fn(), claudeVersion: vi.fn(), codex: vi.fn(), claude: vi.fn(),
}));
const connection = vi.hoisted(() => ({
    handlers: new Map<string, (...args: any[]) => void>(),
    socket: { connected: false, on: vi.fn(), connect: vi.fn(), close: vi.fn(), io: { on: vi.fn() } },
}));
vi.mock('socket.io-client', () => ({ io: () => connection.socket }));
vi.mock('@/codex/modelDiscovery', () => ({
    detectCodexVersion: discovery.codexVersion, discoverCodexCapabilities: discovery.codex,
}));
vi.mock('@/claude/capabilityDiscovery', () => ({
    detectClaudeVersion: discovery.claudeVersion, discoverClaudeCapabilities: discovery.claude,
}));
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn() } }));
vi.mock('@/configuration', () => ({
    configuration: { serverUrl: 'http://relay.test' },
    resolveMachineWorkspaceRoot: () => '/test',
}));
vi.mock('../modules/common/registerCommonHandlers', () => ({ registerCommonHandlers: vi.fn() }));
vi.mock('../modules/common/registerCloudFileHandlers', () => ({ registerCloudFileHandlers: vi.fn() }));
vi.mock('../modules/common/browseMachineDirectory', () => ({ browseMachineDirectory: vi.fn() }));
vi.mock('../codex/codexUpdater', () => ({ createCodexUpdater: vi.fn() }));
vi.mock('@/codex/codexAppServerClient', () => ({ CodexAppServerClient: vi.fn() }));
vi.mock('@/skills/skillFiles', () => ({ readCliSkill: vi.fn(), saveCliSkill: vi.fn(), trashCliSkill: vi.fn() }));
vi.mock('@/utils/lidState', () => ({ shouldReconnect: () => true }));
vi.mock('@/resume/localHaplaAgentAuth', () => ({ detectResumeSupport: vi.fn() }));

import { ApiMachineClient } from './apiMachine';

const previousModels = [{ code: 'old-model', value: 'Old Model', supportedEffortLevels: ['medium'] }];
const previousSkills = [{ name: 'existing-skill', description: 'Keep this skill on partial failure', enabled: true }];
const currentModels = [{
    code: 'new-model', value: 'New Model', description: 'New CLI model', supportedEffortLevels: ['ultra'],
    effortDescriptions: { ultra: 'New CLI reasoning description' }, defaultEffortLevel: 'ultra',
}];

function clientFixture() {
    const client = Object.create(ApiMachineClient.prototype) as any;
    client.machine = { metadata: {
        host: 'test-machine', platform: 'linux', happyCliVersion: '1', happyHomeDir: '/test', homeDir: '/test', happyLibDir: '/test/lib',
        codexVersion: 'codex-cli 0.1.0', codexModels: previousModels,
        cliCapabilities: {
            codex: { version: 'codex-cli 0.1.0', models: previousModels, skills: previousSkills }, discoveredAt: 1,
        },
    } satisfies MachineMetadata };
    client.capabilityRefreshInFlight = null;
    client.lastKnownCodexVersion = 'codex-cli 0.1.0';
    client.lastKnownClaudeVersion = null;
    client.updateMachineMetadata = vi.fn(async (update: (metadata: MachineMetadata) => MachineMetadata) => {
        client.machine.metadata = update(client.machine.metadata);
    });
    return client;
}

beforeEach(() => {
    vi.clearAllMocks();
    discovery.codexVersion.mockReturnValue('codex-cli 0.2.0');
    discovery.claudeVersion.mockReturnValue(null);
    discovery.codex.mockResolvedValue({ models: currentModels, skills: [] });
    discovery.claude.mockResolvedValue({ models: [], skills: [] });
});

afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
});

describe('machine connection during host startup', () => {
    it('keeps retrying initial failures until the relay becomes available without a disconnect event', () => {
        vi.useFakeTimers();
        connection.handlers.clear();
        connection.socket.connected = false;
        connection.socket.on.mockImplementation((event, handler) => connection.handlers.set(event, handler));
        const client = Object.create(ApiMachineClient.prototype) as any;
        client.machine = { id: 'boot-test' };
        client.reconnectInterval = null;
        client.connect();

        const fail = connection.handlers.get('connect_error')!;
        fail(new Error('relay not started'));
        vi.advanceTimersByTime(1000);
        expect(connection.socket.connect).toHaveBeenCalledTimes(1);

        // Another failure must retain one retry loop, not add more timers.
        fail(new Error('relay still starting'));
        vi.advanceTimersByTime(8000);
        expect(connection.socket.connect).toHaveBeenCalledTimes(4);

        connection.socket.connected = true;
        vi.advanceTimersByTime(6000);
        expect(connection.socket.connect).toHaveBeenCalledTimes(4);
        expect(client.reconnectInterval).toBeNull();
        client.shutdown();
    });
});

describe('machine Codex capability refresh', () => {
    it('reports forced discovery failure and retains the previously published catalog', async () => {
        const client = clientFixture();
        const previous = client.machine.metadata;
        discovery.codex.mockRejectedValue(new Error('model/list disconnected'));
        await expect(client.refreshCliCapabilities(true)).rejects.toThrow('已保留上次的列表');
        expect(client.machine.metadata).toBe(previous);
        expect(client.updateMachineMetadata).not.toHaveBeenCalled();
        expect(client.lastKnownCodexVersion).toBe('codex-cli 0.1.0');
        expect(client.capabilityRefreshInFlight).toBeNull();
    });

    it('publishes the latest models and descriptions while keeping skills after partial discovery failure', async () => {
        const client = clientFixture();
        discovery.codex.mockResolvedValue({ models: currentModels, skills: [], skillsError: 'skills/list unsupported' });
        await client.refreshCliCapabilities(true);
        expect(client.machine.metadata.cliCapabilities.codex).toEqual({
            version: 'codex-cli 0.2.0', models: currentModels, skills: previousSkills,
        });
        expect(client.machine.metadata.codexModels).toEqual(currentModels);
        expect(client.updateMachineMetadata).toHaveBeenCalledWith(expect.any(Function), true);
        expect(discovery.codex).toHaveBeenCalledWith(expect.any(String), { strict: true });
    });

    it('runs a fresh discovery after an older in-flight refresh has completed', async () => {
        const client = clientFixture();
        let completeOld!: (value: unknown) => void;
        discovery.codex.mockImplementationOnce(() => new Promise((resolve) => { completeOld = resolve; }));
        const older = client.refreshCliCapabilities();
        const requested = client.refreshCliCapabilities(true);
        expect(discovery.codex).toHaveBeenCalledTimes(1);
        completeOld({ models: previousModels, skills: previousSkills });
        await Promise.all([older, requested]);
        expect(discovery.codex).toHaveBeenCalledTimes(2);
        expect(client.machine.metadata.codexModels).toEqual(currentModels);
        expect(client.capabilityRefreshInFlight).toBeNull();
    });

    it('fails a forced refresh when the installed CLI version cannot be detected', async () => {
        const client = clientFixture();
        const previous = client.machine.metadata;
        discovery.codexVersion.mockReturnValue(null);
        await expect(client.refreshCliCapabilities(true)).rejects.toThrow('无法检测 Codex 版本');
        expect(client.machine.metadata).toBe(previous);
        expect(discovery.codex).not.toHaveBeenCalled();
    });

    it('does not publish an empty model catalog as a successful refresh', async () => {
        const client = clientFixture();
        const previous = client.machine.metadata;
        discovery.codex.mockResolvedValue({ models: [], skills: [] });
        await expect(client.refreshCliCapabilities(true)).rejects.toThrow('已保留上次的列表');
        expect(client.machine.metadata).toBe(previous);
        expect(client.updateMachineMetadata).not.toHaveBeenCalled();
    });

    it('does not report success or advance the version when metadata delivery fails', async () => {
        const client = clientFixture();
        const previous = client.machine.metadata;
        client.updateMachineMetadata.mockRejectedValue(new Error('Acknowledgement timed out'));
        await expect(client.refreshCliCapabilities(true)).rejects.toThrow('已保留上次的列表');
        expect(client.machine.metadata).toBe(previous);
        expect(client.lastKnownCodexVersion).toBe('codex-cli 0.1.0');
    });
});
