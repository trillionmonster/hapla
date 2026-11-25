import { configuration } from '@/configuration';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { mkdir, readFile, readdir, realpath, rename, cp, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { CliSkillMetadata } from '@/codex/modelDiscovery';
import { projectPath } from '@/projectPath';
import {
    INTERACTIVE_MANIFEST_RELATIVE_PATH,
    MAX_INTERACTIVE_MANIFEST_BYTES,
    validateInteractiveSkillManifest,
} from './interactiveSkillManifest';

export type CliSkillProvider = 'codex' | 'claude';

const MAX_SKILL_BYTES = 512 * 1024;
const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function providerHome(provider: CliSkillProvider): string {
    if (provider === 'codex') {
        return process.env.CODEX_HOME || join(homedir(), '.codex');
    }
    return join(homedir(), '.claude');
}

export function getSkillRoots(provider: CliSkillProvider, cwd: string): { user: string; project: string; system: string } {
    return {
        user: join(providerHome(provider), 'skills'),
        // Codex discovers repository-scoped skills from the cross-agent
        // `.agents/skills` convention. `$CODEX_HOME/skills` remains the user root.
        project: provider === 'codex'
            ? join(resolve(cwd), '.agents', 'skills')
            : join(resolve(cwd), '.claude', 'skills'),
        system: join(projectPath(), 'skills'),
    };
}

function isWithin(root: string, candidate: string): boolean {
    const rel = relative(resolve(root), resolve(candidate));
    return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function parseFrontmatter(source: string): { name?: string; description?: string } {
    if (!source.startsWith('---')) return {};
    const end = source.indexOf('\n---', 3);
    if (end < 0) return {};
    const frontmatter = source.slice(3, end);
    const result: { name?: string; description?: string } = {};
    for (const line of frontmatter.split('\n')) {
        const separator = line.indexOf(':');
        if (separator < 0) continue;
        const key = line.slice(0, separator).trim();
        let value = line.slice(separator + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        if (key === 'name' && value) result.name = value;
        if (key === 'description' && value) result.description = value;
    }
    return result;
}

async function findSkillFiles(root: string): Promise<string[]> {
    if (!existsSync(root)) return [];
    const entries = await readdir(root, { withFileTypes: true });
    const paths: string[] = [];
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillPath = join(root, entry.name, 'SKILL.md');
        if (existsSync(skillPath)) paths.push(skillPath);
    }
    return paths;
}

export async function listFileSkills(provider: CliSkillProvider, cwd: string): Promise<CliSkillMetadata[]> {
    const roots = getSkillRoots(provider, cwd);
    const files = await Promise.all([
        findSkillFiles(roots.user).then((paths) => paths.map((path) => ({ path, scope: 'user' }))),
        findSkillFiles(roots.project).then((paths) => paths.map((path) => ({ path, scope: 'project' }))),
    ]);
    return Promise.all(files.flat().map(async ({ path, scope }) => {
        const source = await readFile(path, 'utf8');
        const frontmatter = parseFrontmatter(source);
        return {
            name: frontmatter.name || basename(dirname(path)),
            description: frontmatter.description || '',
            path,
            enabled: true,
            scope,
            argumentHint: null,
        };
    }));
}

export async function mergeClaudeFileSkills(
    discovered: CliSkillMetadata[],
    cwd: string,
): Promise<CliSkillMetadata[]> {
    const files = await listFileSkills('claude', cwd);
    const filesByName = new Map(files.map((skill) => [skill.name, skill]));
    const merged = discovered.map((skill) => {
        const file = filesByName.get(skill.name);
        if (!file) return skill;
        filesByName.delete(skill.name);
        return {
            ...skill,
            description: skill.description || file.description,
            path: file.path,
            scope: file.scope,
        };
    });
    return [...merged, ...filesByName.values()];
}

function assertProvider(provider: string): asserts provider is CliSkillProvider {
    if (provider !== 'codex' && provider !== 'claude') {
        throw new Error('Unsupported skill provider');
    }
}

function assertSkillName(name: string): void {
    if (!SKILL_NAME_PATTERN.test(name)) {
        throw new Error('Skill name must use lowercase letters, numbers, hyphens or underscores');
    }
}

async function resolveAllowedSkillPath(
    provider: CliSkillProvider,
    path: string,
    cwd: string,
    requireWritable: boolean,
): Promise<{ path: string; editable: boolean; scope: 'user' | 'project' | 'system' }> {
    const roots = getSkillRoots(provider, cwd);
    const target = resolve(path);
    const scope = provider === 'codex' && isWithin(roots.system, target)
        ? 'system'
        : isWithin(roots.project, target)
            ? 'project'
            : isWithin(roots.user, target)
                ? 'user'
                : null;
    if (!scope || basename(target) !== 'SKILL.md') {
        throw new Error('Skill path is outside the allowed CLI skill roots');
    }
    const userSystemRoot = join(roots.user, '.system');
    const editable = scope !== 'system' && !isWithin(userSystemRoot, target);
    if (requireWritable && !editable) {
        throw new Error('System skills are read-only');
    }
    const resolvedTarget = existsSync(target) ? await realpath(target) : target;
    if (!(isWithin(roots[scope], resolvedTarget))) {
        throw new Error('Skill path resolves outside its allowed root');
    }
    return { path: resolvedTarget, editable, scope };
}

export async function readCliSkill(options: {
    provider: string;
    path: string;
    cwd: string;
}): Promise<{ source: string; path: string; editable: boolean; scope: 'user' | 'project' | 'system'; interactiveManifest: string | null }> {
    assertProvider(options.provider);
    const allowed = await resolveAllowedSkillPath(options.provider, options.path, options.cwd, false);
    const fileStats = await stat(allowed.path);
    if (fileStats.size > MAX_SKILL_BYTES) {
        throw new Error('Skill source exceeds the 512 KiB editor limit');
    }
    let interactiveManifest: string | null = null;
    if (options.provider === 'codex') {
        const manifestPath = join(dirname(allowed.path), INTERACTIVE_MANIFEST_RELATIVE_PATH);
        try {
            const manifestStats = await stat(manifestPath);
            if (manifestStats.size > MAX_INTERACTIVE_MANIFEST_BYTES) {
                throw new Error('Interactive Skill manifest exceeds the 128 KiB editor limit');
            }
            interactiveManifest = await readFile(manifestPath, 'utf8');
        } catch (error: any) {
            if (error?.code !== 'ENOENT') throw error;
        }
    }
    return { ...allowed, source: await readFile(allowed.path, 'utf8'), interactiveManifest };
}

function defaultSkillSource(name: string, description: string, body?: string): string {
    const safeDescription = description.replace(/[\r\n]+/g, ' ').trim();
    const instructions = body?.trim() || `# ${name}\n\nDescribe when this skill should be used and the workflow it should follow.`;
    return `---\nname: ${name}\ndescription: ${safeDescription || `Instructions for ${name}`}\n---\n\n${instructions}\n`;
}

export async function saveCliSkill(options: {
    provider: string;
    name: string;
    description?: string;
    source?: string;
    interactiveManifest?: string | null;
    path?: string | null;
    cwd: string;
}): Promise<{ path: string; created: boolean; interactive: boolean }> {
    assertProvider(options.provider);
    assertSkillName(options.name);
    const roots = getSkillRoots(options.provider, options.cwd);
    const target = options.path
        ? (await resolveAllowedSkillPath(options.provider, options.path, options.cwd, true)).path
        : join(roots.user, options.name, 'SKILL.md');
    if (!options.path && existsSync(target)) {
        throw new Error(`Skill "${options.name}" already exists`);
    }
    const suppliedSource = options.source?.trim();
    const source = suppliedSource
        ? suppliedSource.startsWith('---')
            ? `${suppliedSource.trimEnd()}\n`
            : defaultSkillSource(options.name, options.description || '', suppliedSource)
        : defaultSkillSource(options.name, options.description || '');
    if (Buffer.byteLength(source, 'utf8') > MAX_SKILL_BYTES) {
        throw new Error('Skill source exceeds the 512 KiB editor limit');
    }
    let normalizedManifest: string | null | undefined;
    if (options.interactiveManifest !== undefined) {
        if (options.provider !== 'codex' && options.interactiveManifest !== null) {
            throw new Error('Interactive Skill services are currently hosted through Codex only');
        }
        const manifestSource = options.interactiveManifest?.trim() ?? '';
        if (!manifestSource) {
            normalizedManifest = null;
        } else {
            if (Buffer.byteLength(manifestSource, 'utf8') > MAX_INTERACTIVE_MANIFEST_BYTES) {
                throw new Error('Interactive Skill manifest exceeds 128 KiB');
            }
            normalizedManifest = `${JSON.stringify(validateInteractiveSkillManifest(JSON.parse(manifestSource)), null, 2)}\n`;
        }
    }
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.hapla-${process.pid}-${Date.now()}.tmp`;
    await writeFile(temporary, source, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, target);

    if (normalizedManifest !== undefined) {
        const manifestPath = join(dirname(target), INTERACTIVE_MANIFEST_RELATIVE_PATH);
        if (normalizedManifest === null) {
            await unlink(manifestPath).catch((error: any) => {
                if (error?.code !== 'ENOENT') throw error;
            });
        } else {
            await mkdir(dirname(manifestPath), { recursive: true });
            const manifestTemporary = `${manifestPath}.hapla-${process.pid}-${Date.now()}.tmp`;
            await writeFile(manifestTemporary, normalizedManifest, { encoding: 'utf8', mode: 0o600 });
            await rename(manifestTemporary, manifestPath);
        }
    }
    const interactive = normalizedManifest === undefined
        ? existsSync(join(dirname(target), INTERACTIVE_MANIFEST_RELATIVE_PATH))
        : normalizedManifest !== null;
    return { path: target, created: !options.path, interactive };
}

export async function trashCliSkill(options: {
    provider: string;
    path: string;
    cwd: string;
}): Promise<{ trashedPath: string }> {
    assertProvider(options.provider);
    const allowed = await resolveAllowedSkillPath(options.provider, options.path, options.cwd, true);
    const skillDirectory = dirname(allowed.path);
    const trashRoot = join(configuration.haplaHomeDir, 'trash', 'skills', options.provider);
    await mkdir(trashRoot, { recursive: true });
    const trashedPath = join(trashRoot, `${Date.now()}-${basename(skillDirectory)}`);
    try { await rename(skillDirectory, trashedPath); }
    catch (error: any) {
        if (error.code !== 'EXDEV') throw error;
        // Skills and private Hapla state may be on separate Docker mounts.
        // Retain the original until a complete recoverable copy exists.
        await cp(skillDirectory, trashedPath, { recursive: true, errorOnExist: true, force: false });
        await rm(skillDirectory, { recursive: true });
    }
    return { trashedPath };
}
