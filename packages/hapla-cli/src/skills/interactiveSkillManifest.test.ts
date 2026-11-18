import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import { discoverInteractiveSkillServers, readInteractiveSkillServer } from './interactiveSkillManifest';

const created: string[] = [];

afterEach(async () => {
    await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(manifest: unknown) {
    const root = await mkdtemp(join(tmpdir(), 'hapla-interactive-skill-'));
    created.push(root);
    await mkdir(join(root, '.hapla'));
    const skillPath = join(root, 'SKILL.md');
    await writeFile(skillPath, '# fixture');
    await writeFile(join(root, '.hapla', 'interactive.json'), JSON.stringify(manifest));
    return { root, skillPath };
}

describe('interactive Skill manifests', () => {
    it('resolves project-relative server paths and inherits only declared environment variables', async () => {
        const { root, skillPath } = await fixture({
            schemaVersion: 1,
            id: 'character-composer',
            mcpServer: { command: 'node', args: ['./server.mjs'], envFromHost: ['PATH'] },
        });
        const result = await readInteractiveSkillServer({
            name: 'character-composer', description: '', path: skillPath, enabled: true, scope: 'repo',
        });
        expect(result?.config.command).toBe('node');
        expect(result?.config.args).toEqual([join(root, 'server.mjs')]);
        expect(result?.config.env?.PATH).toBe(process.env.PATH);
    });

    it('ignores disabled Skills', async () => {
        const { skillPath } = await fixture({
            schemaVersion: 1, id: 'disabled', mcpServer: { command: 'node' },
        });
        await expect(readInteractiveSkillServer({
            name: 'disabled', description: '', path: skillPath, enabled: false, scope: 'repo',
        })).resolves.toBeNull();
    });

    it('reports duplicate ids without replacing the first server', async () => {
        const one = await fixture({ schemaVersion: 1, id: 'same', mcpServer: { command: 'one' } });
        const two = await fixture({ schemaVersion: 1, id: 'same', mcpServer: { command: 'two' } });
        const result = await discoverInteractiveSkillServers([
            { name: 'one', description: '', path: one.skillPath, enabled: true, scope: 'repo' },
            { name: 'two', description: '', path: two.skillPath, enabled: true, scope: 'repo' },
        ]);
        expect(Object.keys(result.servers)).toEqual(['hapla-skill-same']);
        expect(result.errors).toHaveLength(1);
    });

    it('rejects relative server paths that escape the Skill directory', async () => {
        const { skillPath } = await fixture({
            schemaVersion: 1, id: 'escape', mcpServer: { command: 'node', args: ['../outside.mjs'] },
        });
        await expect(readInteractiveSkillServer({
            name: 'escape', description: '', path: skillPath, enabled: true, scope: 'repo',
        })).rejects.toThrow('escapes the Skill directory');
    });
});
