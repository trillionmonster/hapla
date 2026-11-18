import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { CodexSkill } from '@/codex/codexAppServerTypes';

export const INTERACTIVE_MANIFEST_RELATIVE_PATH = '.hapla/interactive.json';
export const MAX_INTERACTIVE_MANIFEST_BYTES = 128 * 1024;

export type InteractiveSkillManifest = {
    schemaVersion: 1;
    id: string;
    displayName?: string;
    mcpServer: {
        command: string;
        args?: string[];
        envFromHost?: string[];
    };
};

export type InteractiveSkillServer = {
    id: string;
    skillName: string;
    skillPath: string;
    displayName: string;
    config: {
        command: string;
        args: string[];
        env?: Record<string, string>;
    };
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function validateInteractiveSkillManifest(value: unknown): InteractiveSkillManifest {
    if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.id !== 'string') {
        throw new Error('Expected schemaVersion 1 and a string id.');
    }
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(value.id)) {
        throw new Error('id must contain lowercase letters, numbers, and hyphens only.');
    }
    if (!isRecord(value.mcpServer) || typeof value.mcpServer.command !== 'string') {
        throw new Error('mcpServer.command is required.');
    }
    const args = value.mcpServer.args;
    if (args !== undefined && (!Array.isArray(args) || args.some((item) => typeof item !== 'string'))) {
        throw new Error('mcpServer.args must be an array of strings.');
    }
    const envFromHost = value.mcpServer.envFromHost;
    if (envFromHost !== undefined && (
        !Array.isArray(envFromHost)
        || envFromHost.some((item) => typeof item !== 'string' || !/^[A-Z_][A-Z0-9_]{0,127}$/.test(item))
    )) {
        throw new Error('mcpServer.envFromHost contains an invalid environment variable name.');
    }
    if (value.displayName !== undefined && typeof value.displayName !== 'string') {
        throw new Error('displayName must be a string.');
    }
    return value as InteractiveSkillManifest;
}

function resolveInsideSkill(value: string, skillDirectory: string): string {
    const resolved = resolve(skillDirectory, value);
    const fromSkill = relative(skillDirectory, resolved);
    if (fromSkill === '..' || fromSkill.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(fromSkill)) {
        throw new Error(`Relative MCP server path escapes the Skill directory: ${value}`);
    }
    return resolved;
}

function resolveExecutable(value: string, skillDirectory: string): string {
    return value.startsWith('./') || value.startsWith('../')
        ? resolveInsideSkill(value, skillDirectory)
        : value;
}

function resolveArgument(value: string, skillDirectory: string): string {
    if (value.startsWith('./') || value.startsWith('../')) {
        return resolveInsideSkill(value, skillDirectory);
    }
    return value;
}

export async function readInteractiveSkillServer(skill: CodexSkill): Promise<InteractiveSkillServer | null> {
    if (!skill.enabled || !isAbsolute(skill.path)) return null;
    const skillDirectory = dirname(skill.path);
    const manifestPath = join(skillDirectory, INTERACTIVE_MANIFEST_RELATIVE_PATH);

    let source: string;
    try {
        source = await readFile(manifestPath, 'utf8');
    } catch (error: any) {
        if (error?.code === 'ENOENT') return null;
        throw error;
    }
    if (Buffer.byteLength(source, 'utf8') > MAX_INTERACTIVE_MANIFEST_BYTES) {
        throw new Error(`${manifestPath} exceeds 128 KiB.`);
    }

    const manifest = validateInteractiveSkillManifest(JSON.parse(source));
    const env: Record<string, string> = {};
    for (const key of manifest.mcpServer.envFromHost ?? []) {
        const value = process.env[key];
        if (value !== undefined) env[key] = value;
    }

    return {
        id: manifest.id,
        skillName: skill.name,
        skillPath: skill.path,
        displayName: manifest.displayName ?? skill.name,
        config: {
            command: resolveExecutable(manifest.mcpServer.command, skillDirectory),
            args: (manifest.mcpServer.args ?? []).map((arg) => resolveArgument(arg, skillDirectory)),
            ...(Object.keys(env).length > 0 ? { env } : {}),
        },
    };
}

export async function discoverInteractiveSkillServers(
    skills: CodexSkill[],
): Promise<{ servers: Record<string, InteractiveSkillServer>; errors: string[] }> {
    const servers: Record<string, InteractiveSkillServer> = {};
    const errors: string[] = [];
    for (const skill of skills) {
        try {
            const server = await readInteractiveSkillServer(skill);
            if (!server) continue;
            const key = `hapla-skill-${server.id}`;
            if (servers[key]) {
                errors.push(`Duplicate interactive Skill id: ${server.id}`);
                continue;
            }
            servers[key] = server;
        } catch (error) {
            errors.push(`${skill.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    return { servers, errors };
}
