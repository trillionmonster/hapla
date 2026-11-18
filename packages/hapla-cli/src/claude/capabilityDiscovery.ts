import { execFileSync } from 'node:child_process';
import {
    query,
    type ModelInfo,
    type SDKUserMessage,
    type SlashCommand,
} from '@anthropic-ai/claude-agent-sdk';
import { logger } from '@/ui/logger';
import type { CodexModelMetadata, CliSkillMetadata } from '@/codex/modelDiscovery';
import { mergeClaudeFileSkills } from '@/skills/skillFiles';

const DISCOVERY_TIMEOUT_MS = 20_000;

export function detectClaudeVersion(): string | null {
    try {
        return execFileSync('claude', ['--version'], {
            encoding: 'utf8',
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim() || null;
    } catch {
        return null;
    }
}

export function mapClaudeModelsToMetadata(models: ModelInfo[]): CodexModelMetadata[] {
    return models.map((model) => ({
        code: model.value,
        value: model.displayName || model.value,
        description: model.description || null,
        supportedEffortLevels: model.supportedEffortLevels ?? [],
        // Claude advertises supported effort values but not a default. Do not
        // invent one; the Web client can select from the advertised list.
        defaultEffortLevel: null,
    }));
}

export function mapClaudeCommandsToSkills(commands: SlashCommand[]): CliSkillMetadata[] {
    return commands.map((command) => ({
        name: command.name,
        description: command.description,
        path: null,
        enabled: true,
        scope: 'claude',
        argumentHint: command.argumentHint || null,
    }));
}

/**
 * Starts Claude's control channel, reads the same catalog shown by `/model`
 * and the slash-command skill registry, then exits before sending a user turn.
 */
export async function discoverClaudeCapabilities(cwd: string = process.cwd()): Promise<{
    models: CodexModelMetadata[];
    skills: CliSkillMetadata[];
}> {
    let releasePrompt: () => void = () => undefined;
    const waitForCleanup = new Promise<void>((resolve) => {
        releasePrompt = resolve;
    });
    const prompt: AsyncIterable<SDKUserMessage> = {
        async *[Symbol.asyncIterator]() {
            await waitForCleanup;
        },
    };

    const session = query({
        prompt,
        options: {
            cwd,
            permissionMode: 'default',
        },
    });
    const timeout = new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error('Claude capability discovery timed out')), DISCOVERY_TIMEOUT_MS);
        timer.unref();
    });

    try {
        const [models, commands] = await Promise.race([
            Promise.all([session.supportedModels(), session.supportedCommands()]),
            timeout,
        ]);
        return {
            models: mapClaudeModelsToMetadata(models),
            skills: await mergeClaudeFileSkills(mapClaudeCommandsToSkills(commands), cwd),
        };
    } catch (error) {
        logger.debug('[Claude capabilities] Failed to discover CLI catalogs:', error);
        return { models: [], skills: [] };
    } finally {
        releasePrompt();
        await session.interrupt().catch(() => undefined);
    }
}
