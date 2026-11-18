import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const originalCodexHome = process.env.CODEX_HOME;
const roots: string[] = [];

afterEach(async () => {
    process.env.CODEX_HOME = originalCodexHome;
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    vi.restoreAllMocks();
});

describe('skillFiles', () => {
    it('ships media-play as a read-only built-in Codex skill', async () => {
        const { getSkillRoots, readCliSkill } = await import('./skillFiles');
        const path = join(getSkillRoots('codex', process.cwd()).system, 'media-play', 'SKILL.md');
        const skill = await readCliSkill({ provider: 'codex', path, cwd: process.cwd() });

        expect(skill.scope).toBe('system');
        expect(skill.editable).toBe(false);
        expect(skill.source).toContain('name: media-play');
    });

    it('uses the Codex project skill root discovered by the CLI', async () => {
        const root = await mkdtemp(join(tmpdir(), 'hapla-skills-'));
        roots.push(root);
        process.env.CODEX_HOME = join(root, '.codex');
        const cwd = join(root, 'workspace');
        const { getSkillRoots } = await import('./skillFiles');

        expect(getSkillRoots('codex', cwd)).toEqual({
            user: join(root, '.codex', 'skills'),
            project: join(cwd, '.agents', 'skills'),
            system: join(process.cwd(), 'skills'),
        });
    });

    it('creates, reads, updates and recoverably trashes a user Codex skill', async () => {
        const root = await mkdtemp(join(tmpdir(), 'hapla-skills-'));
        roots.push(root);
        process.env.CODEX_HOME = join(root, '.codex');
        const cwd = join(root, 'workspace');
        await mkdir(cwd);
        const { readCliSkill, saveCliSkill, trashCliSkill } = await import('./skillFiles');

        const created = await saveCliSkill({ provider: 'codex', name: 'review-code', description: 'Review code', cwd });
        expect(created.created).toBe(true);
        expect((await readCliSkill({ provider: 'codex', path: created.path, cwd })).source).toContain('name: review-code');

        await saveCliSkill({ provider: 'codex', name: 'review-code', source: '---\nname: review-code\ndescription: Updated\n---\n\nDo it.\n', path: created.path, cwd });
        expect(await readFile(created.path, 'utf8')).toContain('description: Updated');

        const trashed = await trashCliSkill({ provider: 'codex', path: created.path, cwd });
        expect(await readFile(join(trashed.trashedPath, 'SKILL.md'), 'utf8')).toContain('Do it.');
    });

    it('rejects skill paths outside the provider roots', async () => {
        const root = await mkdtemp(join(tmpdir(), 'hapla-skills-'));
        roots.push(root);
        process.env.CODEX_HOME = join(root, '.codex');
        const cwd = join(root, 'workspace');
        await mkdir(cwd);
        const outside = join(root, 'outside', 'SKILL.md');
        await mkdir(join(root, 'outside'));
        await writeFile(outside, 'unsafe');
        const { readCliSkill } = await import('./skillFiles');
        await expect(readCliSkill({ provider: 'codex', path: outside, cwd })).rejects.toThrow('outside');
    });
});
