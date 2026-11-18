import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverWorkspaceFileArtifacts, extractWorkspaceArtifactCandidates } from './generatedFileArtifacts';

const roots: string[] = [];

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('generatedFileArtifacts', () => {
    it('keeps referenced documents and SVG while avoiding duplicate image/video/audio cards', async () => {
        const root = await mkdtemp(join(tmpdir(), 'hapla-reference-files-'));roots.push(root);
        const names = ['report.md', 'page.htm', 'vector.svg', 'clip.mp4', 'cover.png', 'voice.wav'];
        await Promise.all(names.map(name => writeFile(join(root, name), 'content')));
        const files = await discoverWorkspaceFileArtifacts(names.map(name => `[${name}](./${name})`).join(' '), root, { includeMedia: false });
        expect(files.map(file => [file.name, file.mimeType])).toEqual([
            ['report.md', 'text/markdown'], ['page.htm', 'text/html'], ['vector.svg', 'image/svg+xml'],
        ]);
    });
    it('extracts local markdown destinations but ignores remote links', () => {
        expect(extractWorkspaceArtifactCandidates('[report](out/report.pdf) [site](https://example.com) [code](<src/a b.ts:12>)'))
            .toEqual(['out/report.pdf', 'src/a b.ts']);
    });

    it('extracts standalone relative and absolute workspace paths used by media-play', () => {
        expect(extractWorkspaceArtifactCandidates([
            'Files:',
            './output/demo.mp4',
            '../shared/audio.mp3',
            '/workspace/report.pdf',
            'A path inside prose ./ignored.mov is not an artifact line.',
        ].join('\n'))).toEqual([
            './output/demo.mp4',
            '../shared/audio.mp3',
            '/workspace/report.pdf',
        ]);
    });

    it('discovers only existing regular workspace files', async () => {
        const root = await mkdtemp(join(tmpdir(), 'hapla-artifact-'));
        roots.push(root);
        await writeFile(join(root, 'report.txt'), 'done');
        const artifacts = await discoverWorkspaceFileArtifacts(
            `[下载报告](${join(root, 'report.txt')}) [越界](/etc/hosts) [缺失](missing.zip)`,
            root,
        );
        expect(artifacts).toEqual([{
            ref: join(root, 'report.txt'),
            name: 'report.txt',
            size: 4,
            mimeType: 'text/plain',
        }]);
    });
});
