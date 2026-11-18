import { mkdtemp, mkdir, rm, symlink, writeFile, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureTurnMediaBaseline, discoverNewTurnMedia, discoverTurnMediaCandidates, mediaCandidateStillReady, mediaFileVersion } from './turnMediaArtifacts';
import * as videoPreview from './workspaceVideoPreview';

const roots: string[] = [];

afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('turnMediaArtifacts', () => {
    it('keeps all 30 outputs rather than truncating discovery at twelve', async () => {
        const root = await mkdtemp(join(tmpdir(), 'hapla-turn-many-'));roots.push(root);
        const options = { workspaceRoot: root };const baseline = await captureTurnMediaBaseline(options);
        await Promise.all(Array.from({ length: 30 }, (_, i) => writeFile(join(root, `clip-${i}.mp4`), 'finished')));
        expect(await discoverNewTurnMedia(baseline, options)).toHaveLength(30);
    });

    it('excludes writes belonging to a later step while preserving explicit provider hints', async () => {
        const root = await mkdtemp(join(tmpdir(), 'hapla-turn-cutoff-'));roots.push(root);
        const baseline = await captureTurnMediaBaseline({ workspaceRoot: root });
        const later = join(root, 'later.png');await writeFile(later, 'image');
        const cutoff = Date.now() - 10_000;await utimes(later, new Date(cutoff + 5000), new Date(cutoff + 5000));
        const options = { workspaceRoot: root, modifiedBefore: cutoff };
        expect((await discoverTurnMediaCandidates(baseline, options)).candidates).toEqual([]);
        expect((await discoverTurnMediaCandidates(baseline, options, [later])).candidates.map(file => file.path)).toEqual([later]);
    });

    it('defers a file changed during the quiet window and permits its later stable version', async () => {
        const root = await mkdtemp(join(tmpdir(), 'hapla-turn-writing-'));roots.push(root);
        const baseline = await captureTurnMediaBaseline({ workspaceRoot: root });
        const path = join(root, 'writing.png');await writeFile(path, 'first');
        const changing = discoverTurnMediaCandidates(baseline, { workspaceRoot: root });
        const writer = new Promise<void>((resolve, reject) => setTimeout(() => { void writeFile(path, 'finished second version').then(() => resolve(), reject); }, 200));
        const result = await changing;await writer;
        expect(result).toEqual({ candidates: [], pending: true });
        expect((await discoverTurnMediaCandidates(baseline, { workspaceRoot: root })).candidates).toHaveLength(1);
    });

    it('ignores private tool directories even when the workspace is home, retaining the current generated root', async () => {
        const root = await mkdtemp(join(tmpdir(), 'hapla-turn-private-'));roots.push(root);
        const generated = join(root, '.codex', 'generated_images');
        const options = { workspaceRoot: root, generatedMediaRoot: generated, threadId: 'mine' };
        const baseline = await captureTurnMediaBaseline(options);
        const directories = ['.runtime/evidence', '.hapla/logs', '.happy/cache', '.codex/generated_images/other', '.codex/generated_images/mine'];
        await Promise.all(directories.map(async directory => { await mkdir(join(root, directory), { recursive: true });await writeFile(join(root, directory, 'image.png'), 'image'); }));
        expect(await discoverNewTurnMedia(baseline, options)).toEqual([join(generated, 'mine', 'image.png')]);
    });

    it('requires a readable video duration and rechecks the exact candidate version', async () => {
        const root = await mkdtemp(join(tmpdir(), 'hapla-turn-probe-'));roots.push(root);
        const path = join(root, 'clip.mp4');await writeFile(path, 'fixture');const info = await stat(path);
        const candidate = { path, size: info.size, version: mediaFileVersion(info), mimeType: 'video/mp4' };
        const probe = vi.spyOn(videoPreview, 'runVideoPreviewProcess').mockResolvedValue(Buffer.from(JSON.stringify({ streams: [{ width: 320, height: 180 }], format: {} })));
        expect(await mediaCandidateStillReady(candidate)).toBe(false);
        probe.mockResolvedValue(Buffer.from(JSON.stringify({ streams: [{ width: 320, height: 180 }], format: { duration: '2' } })));
        expect(await mediaCandidateStillReady(candidate)).toBe(true);
        expect(probe.mock.calls[0][1]).toContain('file,pipe');
        await writeFile(path, 'newer file');expect(await mediaCandidateStillReady(candidate)).toBe(false);
    });
    it('finds only media created or changed during the turn', async () => {
        const root = await mkdtemp(join(tmpdir(), 'hapla-turn-media-'));
        roots.push(root);
        await writeFile(join(root, 'existing.png'), Buffer.from([1]));
        const baseline = await captureTurnMediaBaseline({ workspaceRoot: root });

        await writeFile(join(root, 'created.mp4'), Buffer.from([2, 3]));
        await writeFile(join(root, 'existing.png'), Buffer.from([4, 5, 6]));
        await writeFile(join(root, 'notes.txt'), 'not media');

        expect(await discoverNewTurnMedia(baseline, { workspaceRoot: root }))
            .toEqual([join(root, 'created.mp4'), join(root, 'existing.png')]);
    });

    it('ignores build noise and symlinks that leave the workspace', async () => {
        const root = await mkdtemp(join(tmpdir(), 'hapla-turn-media-'));
        const outside = await mkdtemp(join(tmpdir(), 'hapla-turn-media-outside-'));
        roots.push(root, outside);
        const baseline = await captureTurnMediaBaseline({ workspaceRoot: root });
        await mkdir(join(root, 'dist'), { recursive: true });
        await writeFile(join(root, 'dist', 'bundle.png'), Buffer.from([1, 2]));
        await writeFile(join(outside, 'secret.png'), Buffer.from([3, 4]));
        await symlink(join(outside, 'secret.png'), join(root, 'linked.png'));

        expect(await discoverNewTurnMedia(baseline, { workspaceRoot: root })).toEqual([]);
    });

    it('detects nested image, audio, and video formats without requiring text references', async () => {
        const root = await mkdtemp(join(tmpdir(), 'hapla-turn-media-'));
        roots.push(root);
        const baseline = await captureTurnMediaBaseline({ workspaceRoot: root });
        await mkdir(join(root, 'artifacts', 'media'), { recursive: true });
        await Promise.all([
            writeFile(join(root, 'artifacts', 'media', 'cover.webp'), Buffer.from([1])),
            writeFile(join(root, 'artifacts', 'media', 'voice.opus'), Buffer.from([2])),
            writeFile(join(root, 'artifacts', 'media', 'clip.webm'), Buffer.from([3])),
        ]);

        expect(await discoverNewTurnMedia(baseline, { workspaceRoot: root })).toEqual([
            join(root, 'artifacts', 'media', 'clip.webm'),
            join(root, 'artifacts', 'media', 'cover.webp'),
            join(root, 'artifacts', 'media', 'voice.opus'),
        ]);
    });

    it('observes only the current Codex thread generated-media directory', async () => {
        const workspace = await mkdtemp(join(tmpdir(), 'hapla-turn-workspace-'));
        const generated = await mkdtemp(join(tmpdir(), 'hapla-generated-media-'));
        roots.push(workspace, generated);
        await Promise.all([
            mkdir(join(generated, 'thread-a'), { recursive: true }),
            mkdir(join(generated, 'thread-b'), { recursive: true }),
        ]);
        const options = { workspaceRoot: workspace, threadId: 'thread-a', generatedMediaRoot: generated };
        const baseline = await captureTurnMediaBaseline(options);
        await Promise.all([
            writeFile(join(generated, 'thread-a', 'mine.png'), Buffer.from([1, 2, 3])),
            writeFile(join(generated, 'thread-b', 'other.png'), Buffer.from([4, 5, 6])),
        ]);

        expect(await discoverNewTurnMedia(baseline, options))
            .toEqual([join(generated, 'thread-a', 'mine.png')]);
    });
});
