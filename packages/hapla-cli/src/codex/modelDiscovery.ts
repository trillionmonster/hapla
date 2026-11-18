import { execFileSync } from 'node:child_process';
import { CodexAppServerClient } from './codexAppServerClient';
import type { CodexModel } from './codexAppServerTypes';
import { logger } from '@/ui/logger';
import { readInteractiveSkillServer } from '@/skills/interactiveSkillManifest';
import { projectPath } from '@/projectPath';
import { join } from 'node:path';
import { resolveCodexExecutable } from './utils/resolveCodexExecutable';

export type CodexModelMetadata = {
    code: string;
    value: string;
    description?: string | null;
    supportedEffortLevels: string[];
    effortDescriptions?: Record<string, string>;
    defaultEffortLevel?: string | null;
    supportedServiceTiers?: string[];
};

export type CliSkillMetadata = {
    name: string;
    description: string;
    path?: string | null;
    enabled: boolean;
    scope?: string | null;
    argumentHint?: string | null;
    interactive?: { id: string; displayName: string } | null;
};

async function mapCodexSkillsToMetadata(skills: Awaited<ReturnType<CodexAppServerClient['listSkills']>>): Promise<CliSkillMetadata[]> {
    return await Promise.all(skills.map(async (skill) => {
        const interactive = await readInteractiveSkillServer(skill).catch(() => null);
        return {
            name: skill.name,
            description: skill.shortDescription || skill.description,
            path: skill.path,
            enabled: skill.enabled,
            scope: skill.scope,
            argumentHint: null,
            interactive: interactive ? { id: interactive.id, displayName: interactive.displayName } : null,
        };
    }));
}

export function detectCodexVersion(): string | null {
    try {
        return execFileSync(resolveCodexExecutable(), ['--version'], {
            encoding: 'utf8',
            windowsHide: true,
            timeout: 5_000,
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim() || null;
    } catch {
        return null;
    }
}

export function mapCodexModelsToMetadata(models: CodexModel[]): CodexModelMetadata[] {
    return [...models]
        .filter((model) => !model.hidden && model.model.length > 0)
        .sort((a, b) => Number(b.isDefault) - Number(a.isDefault))
        .map((model) => ({
            // `model` is the value accepted by thread/start and turn/start. `id`
            // is catalog identity and must not be sent as the selected model.
            code: model.model,
            value: model.displayName || model.model,
            description: model.description || null,
            supportedEffortLevels: model.supportedReasoningEfforts.map((effort) => effort.reasoningEffort),
            effortDescriptions: Object.fromEntries(model.supportedReasoningEfforts.map((effort) => [effort.reasoningEffort, effort.description])),
            defaultEffortLevel: model.defaultReasoningEffort || null,
            ...(model.serviceTiers || model.additionalSpeedTiers ? { supportedServiceTiers: model.serviceTiers?.map(tier => tier.id) ?? model.additionalSpeedTiers ?? [] } : {}),
        }));
}

export async function discoverCodexModels(codexArgs: string[] = []): Promise<CodexModelMetadata[]> {
    const client = new CodexAppServerClient(undefined, codexArgs);
    try {
        await client.connect();
        return mapCodexModelsToMetadata(await client.listModels());
    } catch (error) {
        logger.debug('[Codex models] Failed to discover installed model catalog:', error);
        return [];
    } finally {
        await client.disconnect().catch(() => undefined);
    }
}

export async function discoverCodexSkills(cwd: string = process.cwd()): Promise<CliSkillMetadata[]> {
    const client = new CodexAppServerClient();
    try {
        await client.connect();
        await client.setSkillExtraRoots([join(projectPath(), 'skills')]);
        return await mapCodexSkillsToMetadata(await client.listSkills(cwd));
    } catch (error) {
        logger.debug('[Codex skills] Failed to discover installed skills:', error);
        return [];
    } finally {
        await client.disconnect().catch(() => undefined);
    }
}

export async function discoverCodexCapabilities(cwd: string = process.cwd(), options: { strict?: boolean } = {}): Promise<{
    models: CodexModelMetadata[];
    skills: CliSkillMetadata[];
    skillsError?: string;
}> {
    const client = new CodexAppServerClient();
    try {
        await client.connect();
        const [models, skills] = await Promise.allSettled([
            client.listModels(),
            (async () => {
                await client.setSkillExtraRoots([join(projectPath(), 'skills')]);
                return await mapCodexSkillsToMetadata(await client.listSkills(cwd));
            })(),
        ]);
        if (models.status === 'rejected') throw models.reason;
        if (skills.status === 'rejected') {
            logger.debug('[Codex capabilities] Skill discovery failed; preserving model catalog:', skills.reason);
        }
        return {
            models: mapCodexModelsToMetadata(models.value),
            skills: skills.status === 'fulfilled' ? skills.value : [],
            ...(skills.status === 'rejected' ? {
                skillsError: skills.reason instanceof Error ? skills.reason.message : String(skills.reason),
            } : {}),
        };
    } catch (error) {
        logger.debug('[Codex capabilities] Failed to discover CLI catalogs:', error);
        if (options.strict) throw error;
        return { models: [], skills: [] };
    } finally {
        await client.disconnect().catch(() => undefined);
    }
}
